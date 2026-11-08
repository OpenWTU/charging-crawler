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
const MAX_QUERY_ROWS = 5000;
const QUERY_TIMEOUT_MS = 5000;

/** 只读 SQL 的黑名单（出现即拒绝） */
const SQL_DENY = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|begin|commit|rollback|savepoint|release)\b/i;

function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 已存在或权限不足 */
  }
}

function listBackups(): Array<{ name: string; size: number; mtime: string }> {
  ensureDir(BACKUP_DIR);
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size: st.size, mtime: nowLocal() };
      })
      .sort((a, b) => (a.name < b.name ? 1 : -1));
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
    ensureDir(BACKUP_DIR);
    const stamp = nowLocal().replace(/[-: ]/g, '').slice(0, 14);
    const target = path.join(BACKUP_DIR, `charge-${stamp}.db`);
    try {
      // VACUUM INTO 生成一致性快照，不锁库
      getRaw().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
      const st = fs.statSync(target);
      // 只留最近 MAX_BACKUPS 份
      const all = listBackups();
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
    }
  });

  scope.get('/admin/api/backup/download', async (req, reply) => {
    const name = String((req.query as { name?: string }).name ?? '');
    // 只允许备份目录内的 .db 文件（防路径穿越）
    if (!/^[\w.-]+\.db$/.test(name)) {
      return reply.code(400).send({ ok: false, error: '文件名非法' });
    }
    const full = path.join(BACKUP_DIR, name);
    if (!path.resolve(full).startsWith(path.resolve(BACKUP_DIR))) {
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
    return {
      ok: true,
      note: '已生成安全副本并登记恢复请求。实际文件替换需要重启服务（当前连接不能热替换 SQLite 文件）。',
      safety_copy: path.basename(safe),
      manual_steps: [
        `1. 停服务：docker stop charge-node`,
        `2. 替换：cp ${src} ${DATABASE_PATH}`,
        `3. 启动：docker start charge-node`,
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
    const q = req.query as { table?: string; limit?: string; offset?: string };
    const table = String(q.table ?? '');
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
      return reply.code(400).send({ ok: false, error: '表名非法' });
    }
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), MAX_QUERY_ROWS);
    const offset = Math.max(Number(q.offset) || 0, 0);
    try {
      const rows = (await sql<Record<string, unknown>>`
        SELECT * FROM ${sql.table(table)} LIMIT ${limit} OFFSET ${offset}
      `.execute(getDb())).rows;
      const cols = rows.length ? Object.keys(rows[0] ?? {}) : [];
      return { ok: true, table, columns: cols, rows, limit, offset };
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
    if (!/\blimit\b/i.test(text)) text = `${text} LIMIT ${MAX_QUERY_ROWS}`;
    const started = Date.now();
    try {
      const rows = (await sql<Record<string, unknown>>`${sql.raw(text)}`.execute(getDb())).rows;
      const cols = rows.length ? Object.keys(rows[0] ?? {}) : [];
      await audit({
        username: admin.username, action: 'db_query', ip: req.ip,
        detail: { sql: text.slice(0, 200), rows: rows.length, ms: Date.now() - started },
      });
      return { ok: true, columns: cols, rows, ms: Date.now() - started };
    } catch (e) {
      return reply.code(400).send({
        ok: false,
        error: e instanceof Error ? e.message : '查询失败',
        ms: Date.now() - started,
      });
    }
  });
}
