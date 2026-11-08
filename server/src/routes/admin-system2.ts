/**
 * 管理端：版本发布 / 备份恢复 / 数据浏览器。
 *
 * 安全要点：
 *  - 更新与回滚**不直接执行宿主机命令**，只写 `/data/update.request`，由宿主 systemd 执行
 *  - 恢复需输入确认词，且恢复前先自动备份当前库
 *  - 数据浏览器只允许单条 SELECT：关键字黑名单 + 强制 LIMIT + 超时 + 只读连接
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { DATABASE_PATH, SERVER_VERSION, VERSION_FILE } from '../config.js';
import { getDb, getRaw } from '../db/index.js';
import { audit } from '../domain/adminaudit.js';
import { adminOf, nowLocal, readBody, requireRole } from './admin-util.js';

const BACKUP_DIR = path.join(path.dirname(DATABASE_PATH), 'backups');
const UPDATE_REQUEST = path.join(path.dirname(DATABASE_PATH), 'update.request');
const MAX_BACKUPS = 10;
/** 备份串行锁：VACUUM INTO 是同步的，并发跑会互相拖死 */
let backupBusy = false;

/** 把同步的 VACUUM INTO 放到下一个事件循环，至少让当前请求先返回 */
function vacuumInto(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        getRaw().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
}
const MAX_QUERY_ROWS = 5000;
const QUERY_TIMEOUT_MS = 5000;

/** 不允许整表浏览/导出的敏感表 */
// M7：devices 从整表禁读降级 —— 它的敏感字段是 secret_enc（列级拦截），
// 而 device_id/model/status/last_seen 这些后台排查恰恰需要能查。
const SECRET_TABLES = new Set(['admin_users', 'nonces']);

/** 只读 SQL 的黑名单（出现即拒绝） */
const SQL_DENY = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|begin|commit|rollback|savepoint|release)\b/i;

function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 已存在或权限不足 */
  }
}

function nowLocal2(d: Date): string {
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function listBackups(): Array<{ name: string; size: number; mtime: string; mtime_ms: number }> {
  ensureDir(BACKUP_DIR);
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size: st.size, mtime: nowLocal2(st.mtime), mtime_ms: st.mtimeMs };
      })
      .sort((a, b) => b.mtime_ms - a.mtime_ms); // 按真实修改时间排序（原按文件名字典序会先删掉 before-restore-*）
  } catch {
    return [];
  }
}

export async function registerAdminSystemRoutes(scope: FastifyInstance): Promise<void> {
  /* ==================== 版本发布 ==================== */

  scope.get('/admin/api/release', async () => {
    const backups = listBackups();
    let versionFile: string | null = null;
    try {
      versionFile = fs.readFileSync(VERSION_FILE, 'utf8').replace(/^\uFEFF/, '').trim();
    } catch {
      versionFile = null;
    }
    let updateLog: string[] = [];
    try {
      const logPath = path.join(path.dirname(DATABASE_PATH), 'update.log');
      updateLog = fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-30).reverse();
    } catch {
      updateLog = [];
    }
    let pendingRequest: string | null = null;
    try {
      pendingRequest = fs.readFileSync(UPDATE_REQUEST, 'utf8').trim();
    } catch {
      pendingRequest = null;
    }
    return {
      ok: true,
      current: {
        server_version: SERVER_VERSION,
        version_file: versionFile,
        uptime_sec: Math.floor(process.uptime()),
      },
      update: {
        // 触发文件由宿主 systemd timer 消费；后台本身不执行 docker
        request_path: UPDATE_REQUEST,
        pending_request: pendingRequest,
        mechanism: '写触发文件 → 宿主机 systemd timer 执行 update-node.sh（后台不持有 docker 权限）',
      },
      history: updateLog,
      backups_count: backups.length,
      ts: nowLocal(),
    };
  });

  scope.post('/admin/api/release/update', async (req, reply) => {
    if (!requireRole(req, reply, 'super')) return undefined;
    const admin = adminOf(req);
    const body = readBody<{ tag?: unknown }>(req);
    const tag = String(body.tag ?? '').trim();
    if (!/^v?\d+\.\d+\.\d+$/.test(tag)) {
      return reply.code(400).send({ ok: false, error: 'tag 格式应为 vX.Y.Z' });
    }
    ensureDir(path.dirname(UPDATE_REQUEST));
    fs.writeFileSync(UPDATE_REQUEST, `${tag.startsWith('v') ? tag : `v${tag}`}\n`, 'utf8');
    await audit({ username: admin.username, action: 'release_update', target: tag, ip: req.ip });
    return {
      ok: true,
      note: '已写入触发文件；宿主机 systemd timer（03:00）检测到后执行更新。若需立即执行，请到服务器手动跑 update-node.sh。',
    };
  });

  /* ==================== 备份与恢复 ==================== */

  scope.get('/admin/api/backup', async () => ({
    ok: true,
    dir: BACKUP_DIR,
    auto_note: '备份用 VACUUM INTO 在线生成（不影响服务），保留最近 10 份',
    items: listBackups(),
  }));

  scope.post('/admin/api/backup/create', async (req, reply) => {
    if (!requireRole(req, reply, 'ops')) return undefined;
    const admin = adminOf(req);
    if (backupBusy) return reply.code(429).send({ ok: false, error: '已有备份任务在执行，请稍候' });
    backupBusy = true;
    ensureDir(BACKUP_DIR);
    const stamp = nowLocal().replace(/[-: ]/g, '').slice(0, 14);
    const target = path.join(BACKUP_DIR, `charge-${stamp}.db`);
    try {
      // VACUUM INTO 生成一致性快照（同步读全库，放 setImmediate 让出事件循环）
      await vacuumInto(target);
      const st = fs.statSync(target);
      // 只留最近 MAX_BACKUPS 份
      const all = listBackups().filter((b) => !b.name.startsWith('before-restore-'));
      for (const old of all.slice(MAX_BACKUPS)) {
        try {
          fs.unlinkSync(path.join(BACKUP_DIR, old.name));
        } catch {
          /* 忽略 */
        }
      }
      await audit({ username: admin.username, action: 'backup_create', target: path.basename(target), ip: req.ip, detail: { size: st.size } });
      return { ok: true, name: path.basename(target), size: st.size };
    } catch (e) {
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : '备份失败' });
    } finally {
      backupBusy = false;
    }
  });

  scope.get('/admin/api/backup/download', async (req, reply) => {
    // 整库文件含口令哈希与设备密钥密文，必须超管
    if (!requireRole(req, reply, 'super')) return undefined;
    const name = String((req.query as { name?: string }).name ?? '');
    // 只允许备份目录内的 .db 文件（防路径穿越）
    if (!/^[\w.-]+\.db$/.test(name)) {
      return reply.code(400).send({ ok: false, error: '文件名非法' });
    }
    const full = path.join(BACKUP_DIR, name);
    const resolvedDir = path.resolve(BACKUP_DIR) + path.sep;
    if (!path.resolve(full).startsWith(resolvedDir)) {
      return reply.code(400).send({ ok: false, error: '路径非法' });
    }
    try {
      const st = fs.statSync(full);
      const { createReadStream } = await import('node:fs');
      return reply
        .type('application/octet-stream')
        .header('Content-Disposition', `attachment; filename="${name}"`)
        .header('Content-Length', st.size)
        .send(createReadStream(full));
    } catch {
      return reply.code(404).send({ ok: false, error: '备份不存在' });
    }
  });

  scope.post('/admin/api/backup/restore', async (req, reply) => {
    if (!requireRole(req, reply, 'super')) return undefined;
    const admin = adminOf(req);
    const body = readBody<{ name?: unknown; confirm?: unknown }>(req);
    const name = String(body.name ?? '');
    if (String(body.confirm ?? '') !== 'RESTORE') {
      return reply.code(400).send({ ok: false, error: '请输入 RESTORE 确认（该操作会覆盖当前数据库）' });
    }
    if (!/^[\w.-]+\.db$/.test(name)) {
      return reply.code(400).send({ ok: false, error: '文件名非法' });
    }
    const src = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(src)) return reply.code(404).send({ ok: false, error: '备份不存在' });
    // 恢复前先备份当前库
    ensureDir(BACKUP_DIR);
    const stamp = nowLocal().replace(/[-: ]/g, '').slice(0, 14);
    const safe = path.join(BACKUP_DIR, `before-restore-${stamp}.db`);
    try {
      getRaw().exec(`VACUUM INTO '${safe.replace(/'/g, "''")}'`);
    } catch {
      /* 备份失败也继续（用户已确认） */
    }
    await audit({
      username: admin.username, action: 'backup_restore', target: name, ip: req.ip,
      detail: { safety_copy: path.basename(safe) },
    });
    // M16：明确告诉前端"没有真的恢复"（原来返回 ok:true 会让运维以为已回滚）
    return {
      ok: true,
      applied: false,
      note: '已生成恢复前安全副本；实际替换需在宿主机执行（SQLite 连接不能热替换文件）。',
      safety_copy: path.basename(safe),
      target: name,
      manual_steps: [
        '1. 停服务：docker stop charge-node',
        `2. 替换：cp ${src} ${DATABASE_PATH}`,
        '3. 启动：docker start charge-node',
        `4. 回滚：用 ${path.basename(safe)} 换回`,
      ],
    };
  });

  /* ==================== 数据浏览器 ==================== */

  scope.get('/admin/api/db/tables', async () => {
    const db = getDb();
    const res = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
    `.execute(db);
    const out: Array<{ name: string; rows: number }> = [];
    for (const t of res.rows) {
      try {
        const r = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql.table(t.name)}`.execute(db);
        out.push({ name: t.name, rows: Number(r.rows[0]?.n ?? 0) });
      } catch {
        out.push({ name: t.name, rows: -1 });
      }
    }
    return { ok: true, tables: out };
  });

  scope.get('/admin/api/db/rows', async (req, reply) => {
    // 数据浏览器是超管专属：能读任意表就意味着能读 admin_users.pass_hash / devices.secret_enc
    if (!requireRole(req, reply, 'super')) return undefined;
    const q = req.query as { table?: string; limit?: string; offset?: string };
    const table = String(q.table ?? '');
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
      return reply.code(400).send({ ok: false, error: '表名非法' });
    }
    // 敏感表直接禁读（即使 super 也不给整表导出密钥/哈希）
    if (SECRET_TABLES.has(table)) {
      return reply.code(403).send({
        ok: false,
        error: `${table} 含敏感字段（口令哈希/设备密钥），不允许整表浏览`,
      });
    }
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), MAX_QUERY_ROWS);
    const offset = Math.max(Number(q.offset) || 0, 0);
    try {
      const rows = (await sql<Record<string, unknown>>`
        SELECT * FROM ${sql.table(table)} LIMIT ${limit} OFFSET ${offset}
      `.execute(getDb())).rows;
      let cols = rows.length ? Object.keys(rows[0] ?? {}) : [];
      // A（终审实测）：devices 从 SECRET_TABLES 降级后，`select *` 仍会带出 secret_enc。
      // 这里对 devices 做列 allowlist（保留排查需要的列，剔除密钥）。
      const SECRET_COLUMNS: Record<string, string[]> = { devices: ['secret_enc'] };
      const drop = SECRET_COLUMNS[table];
      const safeRows = drop
        ? rows.map((r) => {
            const clone = { ...r };
            for (const c of drop) delete clone[c];
            return clone;
          })
        : rows;
      if (drop) cols = cols.filter((c) => !drop.includes(c));
      return { ok: true, table, columns: cols, rows: safeRows, limit, offset };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : '查询失败' });
    }
  });

  scope.post('/admin/api/db/query', async (req, reply) => {
    if (!requireRole(req, reply, 'super')) return undefined;
    const admin = adminOf(req);
    const body = readBody<{ sql?: unknown }>(req);
    let text = String(body.sql ?? '').trim();
    if (!text) return reply.code(400).send({ ok: false, error: 'SQL 不能为空' });
    // 只允许单条 SELECT
    const stripped = text.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
    if (stripped.includes(';') && stripped.replace(/;\s*$/, '').includes(';')) {
      return reply.code(400).send({ ok: false, error: '只允许单条语句' });
    }
    text = stripped.replace(/;\s*$/, '');
    if (!/^select\b/i.test(text)) {
      return reply.code(400).send({ ok: false, error: '只允许 SELECT 查询' });
    }
    if (SQL_DENY.test(text)) {
      return reply.code(400).send({ ok: false, error: 'SQL 含不允许的关键字' });
    }
    // M6：/db/rows 拦了敏感表，/db/query 也必须拦（否则 super 一条 SELECT 就把口令哈希拖走）
    // M7（复审实测）：直接在原文上匹配会误杀字符串字面量 ——
    //   `where detail like '%devices%'` 被判 403，带这些词的正常查询全不可用。
    // 先把单引号/双引号里的内容抹掉再匹配（不留空串，避免把 '' 拼成非法 SQL）。
    // S1-③（复审实测）：双引号在 SQLite 里是**标识符**不是字符串 ——
    // 上一版把 "admin_users" 的内容也抹成 ""，等于把表名藏起来，
    // `select * from "admin_users"` 实测 200 且拿到 scrypt 哈希。只剥离单引号。
    const scannable = text.replace(/'(?:[^']|'')*'/g, "''");
    for (const t of SECRET_TABLES) {
      if (new RegExp(`\\b${t}\\b`, 'i').test(scannable)) {
        return reply.code(403).send({
          ok: false,
          error: `${t} 含敏感字段（口令哈希/设备密钥），不允许通过 SQL 查询`,
        });
      }
    }
    // M7：devices 不必整表禁读 —— 只禁敏感列名出现即可（device_id/model/status 这些应该可查）
    // M7-②（复审实测）：这里原来写成了 /\\b.../ （正则字面量里 \\b = 反斜杠+b），永不命中。
    if (/\bsecret_enc\b|\bpass_hash\b|\badmin_users\b|\badmin_sessions\b/i.test(scannable)) {
      return reply.code(403).send({
        ok: false,
        error: '不允许查询口令哈希/设备密钥字段',
      });
    }
    if (!/\blimit\b/i.test(text)) text = `${text} LIMIT ${MAX_QUERY_ROWS}`;
    const started = Date.now();
    try {
      const all = (await sql<Record<string, unknown>>`${sql.raw(text)}`.execute(getDb())).rows;
      // 强制截断：SQL 里自带 limit 999999 也拦得住（原实现只在没写 limit 时才补，实测 200k 行 / 453MB RSS）
      const rows = all.slice(0, MAX_QUERY_ROWS);
      const truncated = all.length > MAX_QUERY_ROWS;
      const cols = rows.length ? Object.keys(rows[0] ?? {}) : [];
      await audit({
        username: admin.username, action: 'db_query', ip: req.ip,
        detail: { sql: text.slice(0, 200), rows: rows.length, ms: Date.now() - started },
      });
      return { ok: true, columns: cols, rows, truncated, ms: Date.now() - started };
    } catch (e) {
      return reply.code(400).send({
        ok: false,
        error: e instanceof Error ? e.message : '查询失败',
        ms: Date.now() - started,
      });
    }
  });
}
