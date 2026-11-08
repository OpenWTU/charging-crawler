/**
 * 管理端：上传设备 + 桩与区域。
 *
 * 权限：读 viewer+；写（审批/拉黑/删除/改坐标/合并/同步）ops+。
 * 删除语义：设备与区域均软删（写 deleted_at），快照/采样硬删（在 history 模块）。
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { getDb } from '../db/index.js';
import { audit } from '../domain/adminaudit.js';
import { syncPortsImpl } from '../domain/worker.js';
import {
  adminOf, idList, nowLocal, readBody, requireRole, strList,
} from './admin-util.js';

/** LIKE 通配符转义（否则 q=% 会命中全部） */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export async function registerAdminUnitRoutes(scope: FastifyInstance): Promise<void> {
  /* ==================== 上传设备 ==================== */

  scope.get('/admin/api/devices', async (req) => {
    const q = req.query as { status?: string; q?: string; cursor?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const db = getDb();
    const conditions: ReturnType<typeof sql>[] = [];
    let base = sql`SELECT device_id, model, app_version, status, uploads, last_seen,
                          created_at, revoked, deleted_at
                     FROM devices WHERE COALESCE(deleted_at, '') = ''`;
    if (q.status === 'pending' || q.status === 'approved' || q.status === 'revoked') {
      base = sql`${base} AND status = ${q.status}`;
    }
    if (q.q) {
      const like = `%${likeEscape(String(q.q).trim())}%`;
      base = sql`${base} AND (device_id LIKE ${like} ESCAPE '\\' OR COALESCE(model, '') LIKE ${like} ESCAPE '\\')`;
    }
    if (q.cursor) {
      base = sql`${base} AND created_at < ${q.cursor}`;
    }
    const res = await sql<{
      device_id: string;
      model: string | null;
      app_version: string | null;
      status: string;
      uploads: number;
      last_seen: string | null;
      created_at: string;
      revoked: number;
    }>`${base} ORDER BY created_at DESC LIMIT ${limit}`.execute(db);
    const counts = await sql<{ status: string; n: number }>`
      SELECT status, COUNT(*) AS n FROM devices
       WHERE COALESCE(deleted_at, '') = '' GROUP BY status
    `.execute(db);
    const stat: Record<string, number> = { pending: 0, approved: 0, revoked: 0, total: 0 };
    for (const row of counts.rows) {
      stat[row.status] = Number(row.n);
      stat.total = (stat.total ?? 0) + Number(row.n);
    }
    return { ok: true, items: res.rows, counts: stat, next_cursor: res.rows.at(-1)?.created_at ?? null };
  });

  scope.get('/admin/api/devices/:id', async (req, reply) => {
    const id = String((req.params as { id?: string }).id ?? '');
    if (!id) return reply.code(400).send({ ok: false, error: '缺少设备 ID' });
    const db = getDb();
    const dev = await sql<{
      device_id: string;
      model: string | null;
      app_version: string | null;
      status: string;
      uploads: number;
      created_at: string;
      last_seen: string | null;
      revoked: number;
      deleted_at: string | null;
    }>`SELECT device_id, model, app_version, status, uploads, created_at, last_seen,
              revoked, deleted_at FROM devices WHERE device_id = ${id}`.execute(db);
    if (!dev.rows[0]) return reply.code(404).send({ ok: false, error: '设备不存在' });
    const snaps = await sql<{ id: number; received_at: string; app_version: string | null }>`
      SELECT id, received_at, app_version FROM snapshots
       WHERE device_id = ${id} ORDER BY id DESC LIMIT 30
    `.execute(db);
    const audits = await sql<{ ts: string; ip: string | null; ua: string | null; size: number | null; result: string | null }>`
      SELECT ts, ip, ua, size, result FROM upload_audit
       WHERE detail LIKE ${'%' + likeEscape(id) + '%'} ORDER BY id DESC LIMIT 30
    `.execute(db).catch(() => ({ rows: [] as never[] }));
    return { ok: true, device: dev.rows[0], snapshots: snaps.rows, audit: audits.rows };
  });

  scope.post('/admin/api/devices/approve', async (req, reply) => {
    if (!requireRole(req, reply, 'ops')) return undefined;
    const admin = adminOf(req);
    const body = readBody<{ ids?: unknown }>(req);
    const ids = strList(body.ids);
    if (!ids.length) return reply.code(400).send({ ok: false, error: '未选择设备' });
    const r = await sql`
      UPDATE devices SET status = 'approved'
       WHERE device_id IN (${sql.join(ids)}) AND status = 'pending'
    `.execute(getDb());
    await audit({ username: admin.username, action: 'device_approve', target: ids.join(','), ip: req.ip, detail: { count: Number(r.numAffectedRows ?? 0) } });
    return { ok: true, approved: Number(r.numAffectedRows ?? 0) };
  });

  scope.post('/admin/api/devices/revoke', async (req, reply) => {
    if (!requireRole(req, reply, 'ops')) return undefined;
    const admin = adminOf(req);
    const body = readBody<{ ids?: unknown; revoked?: unknown }>(req);
    const ids = strList(body.ids);
    const revoked = body.revoked === true || body.revoked === 'true';
    if (!ids.length) return reply.code(400).send({ ok: false, error: '未选择设备' });
    const r = await sql`
      UPDATE devices SET revoked = ${revoked ? 1 : 0}, status = ${revoked ? 'revoked' : 'approved'}
       WHERE device_id IN (${sql.join(ids)})
    `.execute(getDb());
    await audit({ username: admin.username, action: revoked ? 'device_revoke' : 'device_restore', target: ids.join(','), ip: req.ip });
    return { ok: true, affected: Number(r.numAffectedRows ?? 0) };
  });

  scope.post('/admin/api/devices/delete', async (req, reply) => {
    if (!requireRole(req, reply, 'ops')) return undefined;
    const admin = adminOf(req);
    const body = readBody<{ ids?: unknown }>(req);
    const ids = strList(body.ids);
    if (!ids.length) return reply.code(400).send({ ok: false, error: '未选择设备' });
    // 软删除：保留数据可追溯
    const r = await sql`
      UPDATE devices SET deleted_at = ${nowLocal()}
       WHERE device_id IN (${sql.join(ids)}) AND COALESCE(deleted_at, '') = ''
    `.execute(getDb());
    await audit({ username: admin.username, action: 'device_delete', target: ids.join(','), ip: req.ip, detail: { count: Number(r.numAffectedRows ?? 0) } });
    return { ok: true, deleted: Number(r.numAffectedRows ?? 0) };
  });

  /* ==================== 区域 ==================== */

  scope.get('/admin/api/units/areas', async (req) => {
    const q = (req.query as { q?: string }).q;
    const db = getDb();
    let base = sql`
      SELECT a.area_id, a.name, a.first_seen, a.last_seen, a.lat, a.lng, a.deleted_at,
             (SELECT COUNT(*) FROM controllers c
               WHERE c.area_name = a.name) AS controllers,
             (SELECT COUNT(*) FROM area_samples s
               WHERE s.area_name = a.name) AS samples
        FROM areas a WHERE COALESCE(a.deleted_at, '') = ''`;
    if (q) base = sql`${base} AND a.name LIKE ${'%' + likeEscape(String(q).trim()) + '%'} ESCAPE '\\'`;
    const res = await sql<{
      area_id: string;
      name: string;
      first_seen: string | null;
      last_seen: string | null;
      lat: number | null;
      lng: number | null;
      controllers: number;
      samples: number;
    }>`${base} ORDER BY a.name`.execute(db);
    return { ok: true, areas: res.rows };
  });

  scope.get('/admin/api/units/area/:areaId', async (req, reply) => {
    const areaId = String((req.params as { areaId?: string }).areaId ?? '');
    const db = getDb();
    const area = await sql<{ area_id: string; name: string; lat: number | null; lng: number | null; first_seen: string | null; last_seen: string | null }>`
      SELECT area_id, name, lat, lng, first_seen, last_seen FROM areas WHERE area_id = ${areaId}
    `.execute(db);
    const row = area.rows[0];
    if (!row) return reply.code(404).send({ ok: false, error: '区域不存在' });
    const devices = await sql<{
      device_hex: string;
      code: string | null;
      qr_device_no: string | null;
      updated_at: string | null;
    }>`
      SELECT device_hex, code, qr_device_no, updated_at FROM controllers
       WHERE area_name = ${row.name} ORDER BY device_hex
    `.execute(db);
    const ports = await sql<{
      device_hex: string;
      port: string;
      status: string | null;
      status_group: string;
      updated_at: string | null;
    }>`
      SELECT p.device_hex, p.port, p.status, p.status_group, p.updated_at
        FROM port_states p JOIN controllers c ON c.device_hex = p.device_hex
       WHERE c.area_name = ${row.name}
       ORDER BY p.device_hex, p.port
    `.execute(db);
    return { ok: true, area: row, devices: devices.rows, ports: ports.rows };
  });

  scope.post('/admin/api/units/area', async (req, reply) => {
    if (!requireRole(req, reply, 'ops')) return undefined;
    const admin = adminOf(req);
    const body = readBody<{ area_id?: unknown; name?: unknown; lat?: unknown; lng?: unknown }>(req);
    const areaId = String(body.area_id ?? '').trim();
    if (!areaId) return reply.code(400).send({ ok: false, error: '缺少 area_id' });
    const sets: string[] = [];
    const db = getDb();
    let q = sql`UPDATE areas SET `;
    const parts: ReturnType<typeof sql>[] = [];
    if (body.lat !== undefined) {
      const lat = Number(body.lat);
      if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
        return reply.code(400).send({ ok: false, error: '纬度非法' });
      }
      parts.push(sql`lat = ${lat}`);
    }
    if (body.lng !== undefined) {
      const lng = Number(body.lng);
      if (!Number.isFinite(lng) || Math.abs(lng) > 180) {
        return reply.code(400).send({ ok: false, error: '经度非法' });
      }
      parts.push(sql`lng = ${lng}`);
    }
    // M3（复审实测）：原来这里就 return 400，而改名块在它后面 —— 导致「只改名」必然
    // 报「没有要修改的字段」。判断挪到 parts 组装完之后（下面已有一份）。

    // M5：改名要传播到 area_samples / controllers，否则历史按旧名分组、live 显示旧名
    let newName: string | null = null;
    if (body.name !== undefined) {
      newName = String(body.name).trim().slice(0, 80);
      if (!newName) return reply.code(400).send({ ok: false, error: '区域名不能为空' });
      // S4（复审实测）：原来排除了软删行，但 areas.name 的 UNIQUE 约束**不排除**软删 →
      // 改成某个"已软删区域的名字"时，采样先被改好、areas 再撞 UNIQUE 失败，留下错位数据。
      // 这里不排除软删行，提前拦住。
      const dup = await sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM areas
         WHERE name = ${newName} AND area_id <> ${areaId}
      `.execute(db);
      if (Number(dup.rows[0]?.n ?? 0) > 0) {
        return reply.code(409).send({ ok: false, error: '该区域名已存在，请改用「合并」' });
      }
      const old = await sql<{ name: string }>`SELECT name FROM areas WHERE area_id = ${areaId}`.execute(db);
      const oldName = old.rows[0]?.name;
      if (oldName && oldName !== newName) {
        // S4：三条 UPDATE 必须在同一事务里 —— 否则改名失败时会留下「采样已改名、areas 未改」
        await db.transaction().execute(async (trx) => {
          await sql`UPDATE area_samples SET area_name = ${newName} WHERE area_name = ${oldName}`.execute(trx);
          await sql`UPDATE controllers SET area_name = ${newName} WHERE area_name = ${oldName}`.execute(trx);
          await sql`UPDATE areas SET name = ${newName} WHERE area_id = ${areaId}`.execute(trx);
        });
        await audit({ username: admin.username, action: 'area_rename', target: `${oldName} → ${newName}`, ip: req.ip });
        return { ok: true, renamed: true };
      }
    }
    if (newName !== null) {
      parts.push(sql`name = ${newName}`);
    }
    if (!parts.length) return reply.code(400).send({ ok: false, error: '没有要修改的字段' });

    // 拼接 SET 片段
    const setSql = parts.reduce((acc, p, i) => (i === 0 ? p : sql`${acc}, ${p}`), sql`` as ReturnType<typeof sql>);
    q = sql`${q}${setSql} WHERE area_id = ${areaId}`;
    void sets;
    const r = await q.execute(db);
    if (!r.numAffectedRows) return reply.code(404).send({ ok: false, error: '区域不存在' });
    await audit({ username: admin.username, action: 'area_update', target: areaId, ip: req.ip, detail: body });
    return { ok: true };
  });

  scope.post('/admin/api/units/area/merge', async (req, reply) => {
    if (!requireRole(req, reply, 'ops')) return undefined;
    const admin = adminOf(req);
    const body = readBody<{ from?: unknown; to?: unknown }>(req);
    const from = String(body.from ?? '').trim();
    const to = String(body.to ?? '').trim();
    if (!from || !to || from === to) {
      return reply.code(400).send({ ok: false, error: '需要两个不同的区域' });
    }
    const db = getDb();
    const rows = await sql<{ area_id: string; name: string }>`
      SELECT area_id, name FROM areas WHERE area_id IN (${from}, ${to})
    `.execute(db);
    const fromRow = rows.rows.find((r) => r.area_id === from);
    const toRow = rows.rows.find((r) => r.area_id === to);
    if (!fromRow || !toRow) return reply.code(404).send({ ok: false, error: '区域不存在' });
    // M3+M4：采样要同时改 area_name 与 area_id（不动 area_id 会让按 id 的聚合指到已删区域）；
    // 三条 UPDATE 必须在一个事务里，否则中途失败会留下半合并状态
    let movedRows = 0;
    await db.transaction().execute(async (trx) => {
      const moved = await sql`
        UPDATE area_samples
           SET area_name = ${toRow.name}, area_id = ${to}
         WHERE area_name = ${fromRow.name} OR area_id = ${from}
      `.execute(trx);
      movedRows = Number(moved.numAffectedRows ?? 0);
      await sql`
        UPDATE controllers SET area_name = ${toRow.name}, area_id = ${to}
         WHERE area_name = ${fromRow.name} OR area_id = ${from}
      `.execute(trx);
      await sql`UPDATE areas SET deleted_at = ${nowLocal()} WHERE area_id = ${from}`.execute(trx);
    });
    await audit({
      username: admin.username,
      action: 'area_merge',
      target: `${fromRow.name} → ${toRow.name}`,
      ip: req.ip,
      detail: { moved_samples: movedRows },
    });
    return { ok: true, moved_samples: movedRows };
  });

  scope.delete('/admin/api/units/area/:areaId', async (req, reply) => {
    if (!requireRole(req, reply, 'ops')) return undefined;
    const admin = adminOf(req);
    const areaId = String((req.params as { areaId?: string }).areaId ?? '');
    const db = getDb();
    const area = await sql<{ name: string }>`SELECT name FROM areas WHERE area_id = ${areaId}`.execute(db);
    const name = area.rows[0]?.name;
    if (!name) return reply.code(404).send({ ok: false, error: '区域不存在' });
    // 影响面预览
    const cnt = await sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM area_samples WHERE area_name = ${name}
    `.execute(db);
    const r = await sql`UPDATE areas SET deleted_at = ${nowLocal()} WHERE area_id = ${areaId}`.execute(db);
    await audit({
      username: admin.username,
      action: 'area_delete',
      target: name,
      ip: req.ip,
      detail: { kept_samples: Number(cnt.rows[0]?.n ?? 0), soft_delete: true },
    });
    return {
      ok: true,
      deleted: Number(r.numAffectedRows ?? 0),
      kept_samples: Number(cnt.rows[0]?.n ?? 0),
      note: '区域已软删，历史采样保留',
    };
  });

  /** 重复区域检测：名称相似（去空格/标点后 Levenshtein）+ 坐标距离 < 50m */
  scope.get('/admin/api/units/duplicates', async () => {
    const db = getDb();
    const res = await sql<{ area_id: string; name: string; lat: number | null; lng: number | null }>`
      SELECT area_id, name, lat, lng FROM areas WHERE COALESCE(deleted_at, '') = ''
    `.execute(db);
    const rows = res.rows;
    // S7：O(n²) 的 Levenshtein 在同步线程里跑，2000 区域实测 6.8 秒会拖死全站
    const MAX_AREAS = 300;
    if (rows.length > MAX_AREAS) {
      return {
        ok: false,
        pairs: [],
        error: `区域数 ${rows.length} 超过 ${MAX_AREAS}，全量两两比对会阻塞服务，请先用搜索缩小范围`,
      };
    }
    const norm = (s: string): string => s.replace(/[\s\-_()（）·]/g, '').toLowerCase();

    function lev(a: string, b: string): number {
      const m = a.length;
      const n = b.length;
      if (!m) return n;
      if (!n) return m;
      let prev = Array.from({ length: n + 1 }, (_, j) => j);
      for (let i = 1; i <= m; i += 1) {
        const cur = [i];
        for (let j = 1; j <= n; j += 1) {
          cur[j] = Math.min(
            (prev[j] ?? 0) + 1,
            (cur[j - 1] ?? 0) + 1,
            (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
          );
        }
        prev = cur;
      }
      return prev[n] ?? 0;
    }
    function distM(a: { lat: number | null; lng: number | null }, b: { lat: number | null; lng: number | null }): number | null {
      if (a.lat === null || a.lng === null || b.lat === null || b.lng === null) return null;
      const R = 6371000;
      const dLat = ((b.lat - a.lat) * Math.PI) / 180;
      const dLng = ((b.lng - a.lng) * Math.PI) / 180;
      const s = Math.sin(dLat / 2) ** 2
        + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
    }

    const pairs: Array<{ a: typeof rows[number]; b: typeof rows[number]; similarity: number; distance_m: number | null; why: string[] }> = [];
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const ra = rows[i];
        const rb = rows[j];
        if (!ra || !rb) continue;
        const na = norm(ra.name);
        const nb = norm(rb.name);
        const maxLen = Math.max(na.length, nb.length) || 1;
        const similarity = 1 - lev(na, nb) / maxLen;
        const d = distM(ra, rb);
        const why: string[] = [];
        if (similarity >= 0.8) why.push('名称相似');
        if (d !== null && d < 50) why.push('坐标相近');
        if (why.length) pairs.push({ a: ra, b: rb, similarity, distance_m: d, why });
      }
    }
    pairs.sort((x, y) => y.similarity - x.similarity);
    return { ok: true, pairs: pairs.slice(0, 50) };
  });

  /* ==================== 桩 ==================== */

  scope.post('/admin/api/units/device/sync', async (req, reply) => {
    if (!requireRole(req, reply, 'ops')) return undefined;
    const admin = adminOf(req);
    const body = readBody<{ device_hex?: unknown }>(req);
    const deviceHex = String(body.device_hex ?? '').trim();
    if (!deviceHex) return reply.code(400).send({ ok: false, error: '缺少 device_hex' });
    try {
      // syncPortsImpl 返回结果串（如 ok:1/1 或 error:...）
      const result = await syncPortsImpl(undefined, [deviceHex]);
      const ok = !/^(error|fail|no-token)/i.test(result);
      await audit({ username: admin.username, action: 'device_sync', target: deviceHex, ip: req.ip, detail: { result } });
      return { ok, result };
    } catch (e) {
      return reply.code(502).send({
        ok: false,
        error: e instanceof Error ? e.message : '同步失败（可能是上游不可达）',
      });
    }
  });

  scope.post('/admin/api/units/device/bind', async (req, reply) => {
    if (!requireRole(req, reply, 'ops')) return undefined;
    const admin = adminOf(req);
    const body = readBody<{ device_hex?: unknown; area_id?: unknown }>(req);
    const deviceHex = String(body.device_hex ?? '').trim();
    const areaId = String(body.area_id ?? '').trim();
    if (!deviceHex || !areaId) return reply.code(400).send({ ok: false, error: '缺少参数' });
    const db = getDb();
    const area = await sql<{ name: string }>`
      SELECT name FROM areas WHERE area_id = ${areaId} AND COALESCE(deleted_at, '') = ''
    `.execute(db);
    const name = area.rows[0]?.name;
    if (!name) return reply.code(404).send({ ok: false, error: '区域不存在或已删除' });
    // S2（复审）：改绑必须同时清空 owner_device —— 否则被抢注的桩即使管理员重新绑定，
    // 归属仍停在攻击者设备上，后续合法数据全被跨设备规则拒绝，且没有任何 UI 能改回来。
    const r = await sql`
      UPDATE controllers
         SET area_id = ${areaId}, area_name = ${name}, owner_device = NULL, updated_at = ${nowLocal()}
       WHERE device_hex = ${deviceHex}
    `.execute(db);
    if (!r.numAffectedRows) return reply.code(404).send({ ok: false, error: '桩不存在' });
    await audit({ username: admin.username, action: 'device_bind', target: deviceHex, ip: req.ip, detail: { area: name } });
    return { ok: true, area: name };
  });

  /**
   * S2（复审）：归属抢注的兜底入口 —— 只有 super 能手工指定/清空某个桩的归属设备。
   * owner_device 传空字符串表示清空（下一个上报它的设备会重新认领）。
   */
  scope.post('/admin/api/units/device/owner', async (req, reply) => {
    if (!requireRole(req, reply, 'super')) return undefined;
    const admin = adminOf(req);
    const body = readBody<{ device_hex?: unknown; owner_device?: unknown }>(req);
    const deviceHex = String(body.device_hex ?? '').trim();
    if (!deviceHex) return reply.code(400).send({ ok: false, error: '缺少 device_hex' });
    const ownerRaw = body.owner_device;
    const owner = ownerRaw === null || ownerRaw === undefined ? '' : String(ownerRaw).trim();
    const db = getDb();
    const r = owner
      ? await sql`UPDATE controllers SET owner_device = ${owner} WHERE device_hex = ${deviceHex}`.execute(db)
      : await sql`UPDATE controllers SET owner_device = NULL WHERE device_hex = ${deviceHex}`.execute(db);
    if (!r.numAffectedRows) return reply.code(404).send({ ok: false, error: '桩不存在' });
    await audit({
      username: admin.username,
      action: 'device_owner_set',
      target: deviceHex,
      ip: req.ip,
      detail: { owner: owner || null },
    });
    return { ok: true, owner: owner || null };
  });
}
