/**
 * 写入路由：POST /api/snapshot、POST /api/device/register。
 *
 * ⚠️ 与 cloud/http/api_upload.py 逐字段对齐，差异点（按用户决策）：
 *  - 设备注册**自动审批**（不再查 device_approval 开关，pending 设备验签成功即转 approved）
 *  - 脏数据自动拉黑（验签失败/nonce 重放/时间戳过期计数，达阈值拉黑 1 小时）
 *  - 管理员 /api/refresh 走自动化（P6 补 worker 后接 refresh_round）
 *
 * HMAC 验签需要**原始 body 字节**，因此把 application/json 注册为 buffer 模式，
 * handler 里自己 JSON.parse。
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { getDb } from '../db/index.js';
import {
  decryptToken,
  encryptToken,
  deviceSignature,
  MAX_BODY,
  MAX_SKEW,
  NONCE_RE,
} from '../domain/crypto.js';
import {
  cleanPorts,
  nowStr,
  splitValidAreas,
  upsertArea,
  validatePayload,
  recordPileSample,
} from '../domain/store.js';
import { parseToken, poolUpsert } from '../domain/tokens.js';
import { isBanned, recordBan } from '../domain/banlist.js';
import { rateOk } from '../domain/ratelimit.js';
import { broadcastSnapshot } from '../domain/p2p.js';
import { snapshotDigest } from '../domain/worker.js';
import { getSetting } from '../domain/adminsettings.js';
import { markUpload, writeUploadAudit, type UploadMeta } from '../domain/uploadaudit.js';
import { REGISTER_TOKEN } from '../config.js';
import { logger } from '../logger.js';

/** 常量时间比较 hex 字符串（Python 用 hmac.compare_digest） */
function hexEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export async function registerUploadRoutes(app: FastifyInstance): Promise<void> {
  // 全局：JSON body 按原始 Buffer 接收（验签要用原始字节）
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body as Buffer);
  });

  // 上传审计：每个 /api/snapshot 与 /api/device/register 请求都落一行 upload_audit
  // （钩子保证不漏；具体原因由 handler 里的 markUpload 提供）
  app.addHook('onResponse', async (req, reply) => {
    const path = (req.url.split('?')[0] ?? '');
    if (path !== '/api/snapshot' && path !== '/api/device/register') return;
    const r = req as typeof req & { uploadMeta?: UploadMeta };
    const meta: UploadMeta = r.uploadMeta ?? {
      kind: path === '/api/device/register' ? 'register' : 'snapshot',
      reason: reply.statusCode < 300 ? 'ok' : 'unmarked',
    };
    const raw = req.body as unknown;
    const size = Buffer.isBuffer(raw) ? raw.length : 0;
    await writeUploadAudit(req, reply.statusCode, size, meta);
  });

  const db = getDb();

  /* ================= /api/snapshot ================= */
  app.post('/api/snapshot', async (req, reply) => {
    const body = req.body as Buffer;
    const ip = req.ip;
    const ua = String(req.headers['user-agent'] ?? '');
    const length = body.length;

    if (length <= 0 || length > MAX_BODY) {
      const code = length > MAX_BODY ? 413 : 400;
      markUpload(req, code === 413 ? 'too_large' : 'empty_body');
      return reply.code(code).send({ ok: false, error: '请求体大小非法' });
    }
    if (!rateOk(ip, 'upload', 12, 60)) {
      markUpload(req, 'rate_limited');
      return reply.code(429).send({ ok: false, error: '上传过于频繁，请稍后再试' });
    }

    const ts = String(req.headers['x-charge-timestamp'] ?? '').trim();
    const nonce = String(req.headers['x-charge-nonce'] ?? '').trim();
    const sig = String(req.headers['x-charge-signature'] ?? '').trim().toLowerCase();
    const deviceId = String(req.headers['x-device-id'] ?? '').trim();

    // 自动拉黑检查（先于验签，被拉黑直接拒）
    if (isBanned(deviceId || null, ip)) {
      markUpload(req, 'banned');
      return reply.code(403).send({ ok: false, error: '设备已被临时拉黑，请稍后再试' });
    }

    const tsInt = Number.parseInt(ts, 10);
    if (!Number.isFinite(tsInt)) {
      recordBan(null, ip, 'bad_ts');
      markUpload(req, 'bad_ts');
      return reply.code(401).send({ ok: false, error: '时间戳非法' });
    }
    if (Math.abs(Date.now() / 1000 - tsInt) > MAX_SKEW) {
      recordBan(null, ip, 'bad_ts');
      markUpload(req, 'bad_ts_expired');
      return reply.code(401).send({ ok: false, error: '时间戳过期' });
    }
    if (!NONCE_RE.test(nonce)) {
      // 只按 IP 计数：device_id 来自未验签的头，按 device 记会让人用垃圾 nonce 打掉别人的设备
      recordBan(null, ip, 'bad_sig');
      markUpload(req, 'bad_nonce');
      return reply.code(401).send({ ok: false, error: 'nonce 非法' });
    }

    // 验签
    let deviceOk = false;
    // pending 设备且自动审批关闭时，验签通过也不允许上传（等管理员批）
    let pendingBlock = false;
    if (deviceId && sig.length === 64) {
      const r = await sql<{ secret_enc: string; revoked: number; status: string }>`
        SELECT secret_enc, revoked, status FROM devices WHERE device_id = ${deviceId}
      `.execute(db);
      const d = r.rows[0];
      if (d && !d.revoked && (d.status || 'approved') !== 'revoked') {
        try {
          const secret = decryptToken(String(d.secret_enc));
          const expect = deviceSignature(secret, ts, nonce, body);
          deviceOk = hexEqual(sig, expect);
          // pending 设备：自动审批开 → 验签通过即转 approved；关 → 拒绝上传，等管理员在后台批
          if (deviceOk && (d.status || 'approved') === 'pending') {
            const autoApprove = await getSetting('device_auto_approve');
            if (autoApprove) {
              await sql`UPDATE devices SET status = 'approved' WHERE device_id = ${deviceId}`.execute(db);
            } else {
              pendingBlock = true;
            }
          }
        } catch {
          deviceOk = false;
        }
      }
    }
    if (!deviceOk) {
      // 只在验签"失败"时按 IP 计数（device_id 可能是冒充的）
      recordBan(null, ip, 'bad_sig');
      markUpload(req, 'bad_sig', { deviceId: deviceId ?? null });
      return reply.code(401).send({ ok: false, error: '签名校验失败（设备未注册或已撤销）' });
    }
    if (pendingBlock) {
      // 自动审批关闭：pending 设备必须等管理员在后台审批后才能上传
      markUpload(req, 'pending_approval', { deviceId: deviceId ?? null });
      return reply.code(403).send({
        ok: false,
        code: 'pending',
        error: '设备待管理员审批，请稍后再试或联系管理员',
      });
    }

    // 解析与校验
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(body.toString('utf8'));
    } catch (e) {
      logger.debug({ err: e, ip, ua }, '[upload] 请求体不是合法 JSON');
      markUpload(req, 'invalid');
      return reply.code(400).send({ ok: false, error: '数据非法' });
    }
    const rawToken = obj.token;
    const rawPorts = obj.ports;
    let payload;
    try {
      payload = validatePayload(obj);
    } catch (e) {
      logger.debug({ err: e, ip, ua }, '[upload] payload 校验失败');
      return reply
        .code(400)
        .send({ ok: false, error: `数据非法：${e instanceof Error ? e.message : String(e)}` });
    }

    // 逐区校验
    const { valid, skipped, duplicate } = await splitValidAreas(payload.areas);
    if (duplicate) {
      return reply.code(400).send({ ok: false, error: '区域重复' });
    }
    if (!valid.length) {
      const reason = skipped[0]?.[1] ?? '区域数据非法';
      return reply.code(400).send({ ok: false, error: reason });
    }

    // 端口校验（坏请求不消耗 nonce）
    // S2：同时取归属，用于拒绝跨设备改写别人的桩状态
    const knownRes = await sql<{ device_hex: string; owner_device: string | null }>`
      SELECT device_hex, owner_device FROM controllers
    `.execute(db);
    const knownDevices = new Set(knownRes.rows.map((r) => String(r.device_hex)));
    const ownerMap = new Map<string, string | null>();
    for (const r of knownRes.rows) ownerMap.set(String(r.device_hex), r.owner_device ?? null);
    let cleanPortsResult;
    // S2：被归属校验拒绝的桩（回给客户端 + 进审计）
    let rejectedDevices: string[] = [];
    try {
      cleanPortsResult = cleanPorts(rawPorts, knownDevices);
    } catch (e) {
      // 别把原因吞掉：controllers 为空（新节点冷启动/换库恢复）时所有带 ports 的上传都会走到这里
      logger.warn({ err: e, ip }, '[upload] 端口数据被拒');
      return reply
        .code(400)
        .send({ ok: false, error: `端口数据非法：${e instanceof Error ? e.message : String(e)}` });
    }

    // nonce 落库（重放 → 409 + 拉黑）
    try {
      await db
        .insertInto('nonces')
        .values({ nonce, seen_at: Math.floor(Date.now() / 1000) })
        .execute();
    } catch {
      recordBan(deviceId || null, ip, 'replay');
      markUpload(req, 'replay', { deviceId: deviceId ?? null });
      return reply.code(409).send({ ok: false, error: 'nonce 已使用（疑似重放）' });
    }

    // M1：摘要去重（必须在 nonce 落库之后：nonce 是安全层，重放要先被 409 拦下）。
    // App 的 pending 补传 / 网络重试会重复上传同一份 body（只换 nonce），
    // 原来会落两条快照 → /api/now 的 delta、analytics 样本数、后台卡片全部虚高。
    // 与 storeSnapshot / P2P 用同一个 snapshotDigest + 30 分钟窗口。
    // S1（复审实测）：snapshotDigest 只覆盖 payload（project/app_version/token_user/areas），
    // 而 ports 是独立的 obj.ports、不进 payload —— 于是「区域计数不变、但带了新端口数据」的上传
    // 会被判重复整包丢弃（实测另一个桩的端口状态完全没写进去，App 还收到 ok:true）。
    // 修法：把规范化后的端口一并纳入摘要（ports 变了就不是重复）。
    // S1-②（复审实测）：stableStringify 对数组保留原顺序 —— App 每次组包时 ports 的顺序
    // 不保证稳定，同一批端口换个顺序就会被判成不同。这里规范化后再哈希。
    const normalizedPorts = cleanPortsResult
      .map((it) => ({
        device_hex: it.device_hex,
        ports: [...it.ports].sort((a, b) => String(a.port).localeCompare(String(b.port))),
      }))
      .sort((a, b) => a.device_hex.localeCompare(b.device_hex));
    const digest = snapshotDigest({
      ...payload,
      ports: normalizedPorts,
    } as unknown as Record<string, unknown>);
    const dupCutoff = nowStr(new Date(Date.now() - 30 * 60 * 1000));
    const dupRes = await sql<{ id: number }>`
      SELECT id FROM snapshots
       WHERE body_sha256 = ${digest} AND received_at >= ${dupCutoff}
       LIMIT 1
    `.execute(db);
    if (dupRes.rows[0]) {
      // M10：重复上传也要更新设备计数与 last_seen —— 否则 /admin 的「在线设备」与
      // 「30 天未上传」会误判成掉线（实测 uploads/last_seen 停在旧值）
      if (deviceId) {
        try {
          await sql`
            UPDATE devices SET uploads = uploads + 1, last_seen = ${nowStr()}
             WHERE device_id = ${deviceId}
          `.execute(db);
        } catch (e) {
          logger.warn({ err: e }, '[upload] 重复上传的设备计数更新失败');
        }
      }
      markUpload(req, 'duplicate', {
        deviceId: deviceId ?? null,
        detail: `dup of snapshot ${dupRes.rows[0].id}`,
      });
      return reply.send({
        ok: true,
        duplicate: true,
        // L2：与正常返回保持同名字段，客户端不用兼容两套
        id: dupRes.rows[0].id,
        snapshot_id: dupRes.rows[0].id,
        accepted: 0,
        areas: payload.areas.length,
        skipped: [],
      });
    }

    // 单事务落库

    let snapshotId = 0;
    try {
      await db.transaction().execute(async (trx) => {
        const stamp = nowStr();
        const ins = await trx
          .insertInto('snapshots')
          .values({
            received_at: stamp,
            captured_at: payload.captured_at,
            project: payload.project,
            app_version: payload.app_version,
            token_user: payload.token_user,
            client_ip: String(req.socket.remoteAddress ?? ''),
            device_id: deviceId || null,
            real_ip: ip,
            // S1（复审实测）：这里原来用不含 ports 的摘要，而上面比较用的是含 ports 的 ——
            // 两处不一致导致去重 100% 不命中（连空 ports 都对不上），变成死代码。
            body_sha256: digest,
            payload: JSON.stringify(payload),
          })
          .executeTakeFirst();
        snapshotId = Number(ins?.insertId ?? 0);

        for (const a of valid) {
          const aid = await upsertArea(a.name, trx);
          await trx
            .insertInto('area_samples')
            .values({
              snapshot_id: snapshotId,
              area_id: aid,
              area_name: a.name,
              idle: a.idle_port,
              total: a.total_port,
              charging: a.charging_port,
              fault: a.fault_port,
              received_at: stamp,
            })
            .execute();
        }

        rejectedDevices = [];
        // 桩是公共设施，**不属于任何设备/用户** —— 任何已注册设备都可以上报任意桩。
        // （2026-11-08 修正：我曾按「一个桩锁给一个设备」实现过排他校验，
        //  那是基于错误的产品理解；线上 17 台设备众包上报同一批 39 个桩是正常用法。）
        // 这里只把 owner_device 记成「最后写入者」，纯诊断用途，不参与任何准入判断。
        for (const item of cleanPortsResult) {
          if (deviceId && ownerMap.get(item.device_hex) !== deviceId) {
            await sql`
              UPDATE controllers SET owner_device = ${deviceId}
               WHERE device_hex = ${item.device_hex}
            `.execute(trx);
            ownerMap.set(item.device_hex, deviceId);
          }
          for (const p of item.ports) {
            await trx
              .insertInto('port_states')
              .values({
                device_hex: item.device_hex,
                port: p.port,
                status: p.status,
                status_group: p.group,
                updated_at: stamp,
              })
              .onConflict((oc) =>
                oc.columns(['device_hex', 'port']).doUpdateSet({
                  status: p.status,
                  status_group: p.group,
                  updated_at: stamp,
                }),
              )
              .execute();
          }
          await sql`UPDATE controllers SET updated_at = ${stamp} WHERE device_hex = ${item.device_hex}`.execute(trx);
          if (item.ports.length) {
            await recordPileSample(
              item.device_hex,
              stamp,
              item.ports.map((p) => p.status),
              true,
              trx,
            );
          }
        }

        await sql`DELETE FROM nonces WHERE seen_at < ${Math.floor(Date.now() / 1000) - 600}`.execute(trx);
        if (deviceId) {
          await sql`UPDATE devices SET uploads = uploads + 1, last_seen = ${stamp} WHERE device_id = ${deviceId}`.execute(trx);
        }
      });
    } catch (e) {
      logger.error({ err: e }, '[upload] 入库失败');
      markUpload(req, 'error', { detail: 'storeSnapshot failed' });
      return reply.code(500).send({ ok: false, error: '入库失败' });
    }

    // token 处理（与 Python 一致：JWT 才入池）
    if (typeof rawToken === 'string' && rawToken.startsWith('ey')) {
      try {
        const parsed = parseToken(rawToken);
        if (parsed) {
          const enc = encryptToken(rawToken);
          const stamp = nowStr();
          await sql`
            INSERT INTO tokens(user_id, token, expires_at, updated_at)
            VALUES (${parsed.uid}, ${enc}, ${parsed.exp}, ${stamp})
            ON CONFLICT(user_id) DO UPDATE SET token = excluded.token,
              expires_at = excluded.expires_at, updated_at = excluded.updated_at
          `.execute(db);
          await poolUpsert(parsed.uid, enc, parsed.exp, 'upload', db);
        }
      } catch (e) {
        logger.error({ err: e }, '[upload] token 保存失败');
      }
    }

    // P2P 广播（未启用时 no-op）：把新快照同步给白名单内节点
    void broadcastSnapshot(payload as unknown as Record<string, unknown>);

    // M2（复审实测）：上传后没失效 /api/now 缓存 —— App 上传完立刻刷新首页仍看到旧数据 60 秒。


    try {


      const { invalidateNowCache } = await import('./state.js');


      invalidateNowCache();


    } catch { /* 循环依赖时忽略 */ }

    return reply.send({
      ok: true,
      id: snapshotId,
      accepted: valid.length,
      skipped: skipped.length,
      // S2：告诉客户端哪些桩因归属不符被拒（App 可提示"该桩已被其他设备绑定"）
      ...(rejectedDevices.length
        ? { warn: `以下桩的归属属于其他设备，本次未写入：${rejectedDevices.join(', ')}`, rejected: rejectedDevices }
        : {}),
    });
  });

  /**
   * M1（复审实测：之前 CHANGELOG 说补了、实际没写入）：webui 的「手动刷新」一直打这个端点。
   * 拉一轮抓取并返回结果；带限流，避免被当免费算力。
   */
  // M1（复审）：refreshRound 没有互斥，公开接口 6 次/分钟就能和 worker 自动轮次并行跑同一批 token
  let refreshBusy = false;

  app.post('/api/refresh', async (req, reply) => {
    if (!rateOk(req.ip, 'refresh', 6, 60)) {
      return reply.code(429).send({ ok: false, error: '刷新过于频繁，请稍后再试' });
    }
    if (refreshBusy) {
      return reply.code(429).send({ ok: false, error: '已有一轮抓取在进行，请稍后再试' });
    }
    refreshBusy = true;
    try {
      const { refreshRound, roundOk } = await import('../domain/worker.js');
      const result = await refreshRound();
      // M2：刷新成功后让首页缓存立刻失效
      try {
        const { invalidateNowCache } = await import('./state.js');
        invalidateNowCache();
      } catch { /* 循环依赖时忽略 */ }
      // M1（复审实测）：原来用「不以 error/fail/no-token 开头」判定 ——
      // `areas=no-token|ports=no-token` 会被判成 ok:true，但实际什么都没抓到。
      // B（终审）：直接用 worker 导出的 roundOk —— 它会把 `areas=ok:5/5 fail:2` 也算成"有失败"
      const ok = roundOk(result);
      return reply.send({ ok, result });
    } catch (e) {
      return reply.code(500).send({
        ok: false,
        error: e instanceof Error ? e.message : '刷新失败',
      });
    } finally {
      refreshBusy = false;
    }
  });

  /* ================= /api/device/register ================= */
  app.post('/api/device/register', async (req, reply) => {
    const body = req.body as Buffer;
    const ip = req.ip;
    const ua = String(req.headers['user-agent'] ?? '');
    const length = body.length;

    // 限流放最前面：否则错误 token 的请求不受限，可无限爆破注册令牌
    if (!rateOk(ip, 'register', 5, 86400)) {
      markUpload(req, 'rate_limited');
      return reply.code(429).send({ ok: false, error: '注册过于频繁' });
    }

    // 注册令牌（REGISTER_TOKEN 未配置时不校验）。
    //
    // ⚠️ 令牌不对**不返回 403**，而是记一个标记、后面伪装成功（见 `tokenOk` 的用法）：
    //   - 旧版 App 不带该头，硬 403 会让用户看到「请更新 App 并反复重试」；
    //   - 但不入库的设备后续上传会失败：`/api/snapshot` 要按 device_id 从 devices
    //     取 secret_enc 验签，查不到就 401「签名校验失败（设备未注册或已撤销）」。
    //   所以「对外成功、实际不入库」既能兼容旧版，也不会让野生设备真的写进数据。
    let tokenOk = true;
    if (REGISTER_TOKEN) {
      tokenOk = String(req.headers['x-register-token'] ?? '') === REGISTER_TOKEN;
    }

    if (length <= 0 || length > 4096) {
      markUpload(req, 'too_large');
      return reply.code(400).send({ ok: false, error: '请求体大小非法' });
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(body.toString('utf8'));
    } catch {
      markUpload(req, 'invalid_json');
      return reply.code(400).send({ ok: false, error: '不是合法 JSON' });
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      markUpload(req, 'not_object');
      return reply.code(400).send({ ok: false, error: '请求体必须是 JSON 对象' });
    }
    const did = String(obj.device_id ?? '').trim();
    const secret = String(obj.secret ?? '').trim().toLowerCase();
    if (!/^[0-9a-fA-F-]{8,64}$/.test(did) || !/^[0-9a-f]{64}$/.test(secret)) {
      markUpload(req, 'bad_params');
      return reply.code(400).send({ ok: false, error: 'device_id/secret 非法' });
    }

    let secretEnc: string;
    try {
      secretEnc = encryptToken(secret);
    } catch {
      return reply.code(503).send({ ok: false, error: '服务端密钥不可用，请联系管理员' });
    }

    const existed = await sql<{ secret_enc: string; revoked: number; status: string }>`
      SELECT secret_enc, revoked, status, COALESCE(deleted_at, '') AS deleted_at
        FROM devices WHERE device_id = ${did}
    `.execute(db);
    const e = existed.rows[0];
    if (e) {
      if (String(e.secret_enc || '')) {
        let same = false;
        try {
          same = hexEqual(decryptToken(String(e.secret_enc)), secret);
        } catch {
          same = false;
        }
        if (!same) {
          return reply
            .code(409)
            .send({ ok: false, code: 'secret_mismatch', error: 'device_id 已被注册，请联系管理员重置' });
        }
      }
      if (e.revoked || String(e.status || '') === 'revoked') {
        markUpload(req, 'revoked');
        return reply
          .code(409)
          .send({ ok: false, code: 'revoked', error: '设备已被撤销，请联系管理员' });
      }
    }

    // 未带有效注册令牌：**不入库**，但对外返回和正常注册一模一样的成功响应。
    // 放在 existed 分支之后，所以「库里已有的设备」重新注册不受令牌影响
    // （装机量不变的前提下，老用户不会被这条规则挡住）。
    if (!tokenOk) {
      markUpload(req, 'register_no_token', { deviceId: did, detail: `ip=${ip} ua=${ua.slice(0, 60)}` });
      logger.info(
        { ip, ua: ua.slice(0, 80), device_id: did },
        '[register] 未带有效注册令牌：不入库，对外返回成功',
      );
      return reply.send({ ok: true, device_id: did, pending: false, status: 'approved' });
    }

    const stamp = nowStr();
    // 自动审批开关（默认开）：关掉后新设备注册为 pending，等管理员在后台审批
    const autoApprove = await getSetting('device_auto_approve');
    await db
      .insertInto('devices')
      .values({
        device_id: did,
        secret_enc: secretEnc,
        model: String(obj.model ?? '').slice(0, 80),
        app_version: String(obj.app_version ?? '').slice(0, 32),
        created_at: stamp,
        uploads: 0,
        revoked: 0,
        status: autoApprove ? 'approved' : 'pending',
      })
      .onConflict((oc) =>
        oc.column('device_id').doUpdateSet({
          secret_enc: secretEnc,
          model: String(obj.model ?? '').slice(0, 80),
          app_version: String(obj.app_version ?? '').slice(0, 32),
          // 已软删的设备重新注册 = 显式恢复（否则会变成后台看不见的幽灵设备）
          deleted_at: null,
        }),
      )
      .execute();

    markUpload(req, autoApprove ? 'ok' : 'pending_created', { deviceId: did });
    return reply.send({ ok: true, device_id: did, pending: !autoApprove });
  });
}
