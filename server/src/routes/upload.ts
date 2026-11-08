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

  const db = getDb();

  /* ================= /api/snapshot ================= */
  app.post('/api/snapshot', async (req, reply) => {
    const body = req.body as Buffer;
    const ip = req.ip;
    const ua = String(req.headers['user-agent'] ?? '');
    const length = body.length;

    if (length <= 0 || length > MAX_BODY) {
      const code = length > MAX_BODY ? 413 : 400;
      return reply.code(code).send({ ok: false, error: '请求体大小非法' });
    }
    if (!rateOk(ip, 'upload', 12, 60)) {
      return reply.code(429).send({ ok: false, error: '上传过于频繁，请稍后再试' });
    }

    const ts = String(req.headers['x-charge-timestamp'] ?? '').trim();
    const nonce = String(req.headers['x-charge-nonce'] ?? '').trim();
    const sig = String(req.headers['x-charge-signature'] ?? '').trim().toLowerCase();
    const deviceId = String(req.headers['x-device-id'] ?? '').trim();

    // 自动拉黑检查（先于验签，被拉黑直接拒）
    if (isBanned(deviceId || null, ip)) {
      return reply.code(403).send({ ok: false, error: '设备已被临时拉黑，请稍后再试' });
    }

    const tsInt = Number.parseInt(ts, 10);
    if (!Number.isFinite(tsInt)) {
      recordBan(deviceId || null, ip, 'bad_ts');
      return reply.code(401).send({ ok: false, error: '时间戳非法' });
    }
    if (Math.abs(Date.now() / 1000 - tsInt) > MAX_SKEW) {
      recordBan(deviceId || null, ip, 'bad_ts');
      return reply.code(401).send({ ok: false, error: '时间戳过期' });
    }
    if (!NONCE_RE.test(nonce)) {
      // 只按 IP 计数：device_id 来自未验签的头，按 device 记会让人用垃圾 nonce 打掉别人的设备
      recordBan(null, ip, 'bad_sig');
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
      recordBan(deviceId || null, ip, 'bad_sig');
      return reply.code(401).send({ ok: false, error: '签名校验失败（设备未注册或已撤销）' });
    }
    if (pendingBlock) {
      // 自动审批关闭：pending 设备必须等管理员在后台审批后才能上传
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
    const knownRes = await sql<{ device_hex: string }>`SELECT device_hex FROM controllers`.execute(db);
    const knownDevices = new Set(knownRes.rows.map((r) => String(r.device_hex)));
    let cleanPortsResult;
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
      return reply.code(409).send({ ok: false, error: 'nonce 已使用（疑似重放）' });
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
            body_sha256: snapshotDigest(payload as unknown as Record<string, unknown>),
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

        for (const item of cleanPortsResult) {
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

    return reply.send({
      ok: true,
      id: snapshotId,
      accepted: valid.length,
      skipped: skipped.length,
    });
  });

  /* ================= /api/device/register ================= */
  app.post('/api/device/register', async (req, reply) => {
    const body = req.body as Buffer;
    const ip = req.ip;
    const ua = String(req.headers['user-agent'] ?? '');
    const length = body.length;

    // 限流放最前面：否则错误 token 的请求不受限，可无限爆破注册令牌
    if (!rateOk(ip, 'register', 5, 86400)) {
      return reply.code(429).send({ ok: false, error: '注册过于频繁' });
    }

    // 注册令牌（REGISTER_TOKEN 未配置时不校验，兼容已装机的旧版 App）
    if (REGISTER_TOKEN) {
      const got = String(req.headers['x-register-token'] ?? '');
      if (got !== REGISTER_TOKEN) {
        return reply.code(403).send({
          ok: false,
          code: 'register_token_invalid',
          // 两种可能：App 版本过旧（不带该头），或服务端 REGISTER_TOKEN 配错。
          // 不要只说「请更新 App」——配置失误时会把运维问题误导向用户。
          error: '注册未授权：App 版本过旧或服务端 REGISTER_TOKEN 与服务端不一致',
        });
      }
    }

    if (length <= 0 || length > 4096) {
      return reply.code(400).send({ ok: false, error: '请求体大小非法' });
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(body.toString('utf8'));
    } catch {
      return reply.code(400).send({ ok: false, error: '不是合法 JSON' });
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return reply.code(400).send({ ok: false, error: '请求体必须是 JSON 对象' });
    }
    const did = String(obj.device_id ?? '').trim();
    const secret = String(obj.secret ?? '').trim().toLowerCase();
    if (!/^[0-9a-fA-F-]{8,64}$/.test(did) || !/^[0-9a-f]{64}$/.test(secret)) {
      return reply.code(400).send({ ok: false, error: 'device_id/secret 非法' });
    }

    let secretEnc: string;
    try {
      secretEnc = encryptToken(secret);
    } catch {
      return reply.code(503).send({ ok: false, error: '服务端密钥不可用，请联系管理员' });
    }

    const existed = await sql<{ secret_enc: string; revoked: number; status: string }>`
      SELECT secret_enc, revoked, status FROM devices WHERE device_id = ${did}
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
        return reply
          .code(409)
          .send({ ok: false, code: 'revoked', error: '设备已被撤销，请联系管理员' });
      }
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
        }),
      )
      .execute();

    return reply.send({ ok: true, device_id: did, pending: !autoApprove });
  });
}
