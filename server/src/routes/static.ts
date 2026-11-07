/**
 * 静态资源 + 版本元数据 + 原始快照。
 *
 * ⚠️ 与 `cloud/http/static.py::_static_get`、`api_analytics.py::_route_version/_route_latest`
 * 行为一致：
 *   /assets/<单层文件名>  → 长缓存 immutable（拒绝含 / \ .. 的名字）
 *   /                    → index.html
 *   /index.html          → index.html
 *   /download/<*.apk>    → APK 下载（文件名必须匹配 ^[A-Za-z0-9._-]+\.apk$）
 *   其他未匹配           → JSON 404
 *
 * 注意：这里刻意**不支持** /app.html、/admin.html —— Python 版也只认 `/` 和
 * `/index.html`。Android 用的是 appassets 虚拟域名下的本地文件，不走服务器。
 */
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { APK_DIR, VERSION_FILE, WEB_DIST } from '../config.js';
import { getDb } from '../db/index.js';
import { logger } from '../logger.js';
import { rateOk } from '../domain/ratelimit.js';

const APK_NAME_RE = /^[A-Za-z0-9._-]+\.apk$/;

function contentType(name: string): string {
  if (name.endsWith('.css')) return 'text/css';
  if (name.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (name.endsWith('.json')) return 'application/json; charset=utf-8';
  if (name.endsWith('.svg')) return 'image/svg+xml';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

/** 原始快照（/api/latest）：最新一条 snapshots.payload，剥掉 token_user。 */
export async function latestPayload(): Promise<
  { ok: false; status: number; error: string } | { received_at: string; snapshot: unknown }
> {
  const db = getDb();
  const res = await sql<{ received_at: string; payload: string }>`
    SELECT received_at, payload FROM snapshots ORDER BY id DESC LIMIT 1
  `.execute(db);
  const row = res.rows[0];
  if (!row) return { ok: false, status: 404, error: '还没有数据' };
  let snap: Record<string, unknown>;
  try {
    snap = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    return { ok: false, status: 500, error: '快照数据损坏' };
  }
  delete snap.token_user; // 与 Python 一致：不向外暴露上传者身份
  return { received_at: row.received_at, snapshot: snap };
}

export async function registerStaticRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------- /api/version ---------------- */
  app.get('/api/version', async (_req, reply) => {
    try {
      const raw = await fs.readFile(VERSION_FILE, 'utf8');
      // 去掉 UTF-8 BOM：App 侧 new JSONObject(text) 遇到 BOM 会解析失败，
      // 表现是「检查更新一直失败」而服务器看着一切正常
      return reply.type('application/json; charset=utf-8').send(raw.replace(/^\uFEFF/, ''));
    } catch {
      return reply.code(404).send({ ok: false, error: 'version.json 未配置' });
    }
  });

  /* ---------------- /api/latest ---------------- */
  app.get('/api/latest', async (_req, reply) => {
    const r = await latestPayload();
    if ('ok' in r && r.ok === false) {
      return reply.code(r.status).send({ ok: false, error: r.error });
    }
    return reply.send(r);
  });

  /* ---------------- /assets/<单层文件名> ---------------- */
  app.get('/assets/:name', async (req, reply) => {
    if (!rateOk(req.ip, 'static', 300, 60)) {
      return reply.code(429).send({ ok: false, error: 'too many requests' });
    }
    const name = (req.params as Record<string, string>).name ?? '';
    // 与 Python 一致：单层文件名，拒绝路径穿越（/ \ .. 全部拒绝）
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
      return reply.code(404).send({ ok: false, error: 'not found' });
    }
    // lgtm[js/path-injection]：name 已用白名单校验（单层、无 / \ ..），不会穿越
    const file = path.join(WEB_DIST, 'assets', name);
    try {
      const st = await fs.stat(file);
      if (!st.isFile()) throw new Error('not a file');
      // 用流发送：echarts 单个就 500KB，读进内存发不划算
      return reply
        .type(contentType(name))
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .header('Content-Length', st.size)
        .send(createReadStream(file));
    } catch {
      return reply.code(404).send({ ok: false, error: 'not found' });
    }
  });

  /* ---------------- / 与 /index.html ---------------- */
  const sendIndex = async (_req: unknown, reply: import('fastify').FastifyReply) => {
    const file = path.join(WEB_DIST, 'index.html');
    try {
      const st = await fs.stat(file);
      return reply
        .type('text/html; charset=utf-8')
        .header('Content-Length', st.size)
        .send(createReadStream(file));
    } catch {
      return reply.code(500).send({ ok: false, error: '页面缺失' });
    }
  };
  app.get('/', sendIndex);
  app.get('/index.html', sendIndex);

  /* ---------------- /download/<*.apk> ---------------- */
  app.get('/download/:name', async (req, reply) => {
    if (!rateOk(req.ip, 'download', 20, 60)) {
      return reply.code(429).send({ ok: false, error: 'too many requests' });
    }
    const name = (req.params as Record<string, string>).name ?? '';
    if (!APK_NAME_RE.test(name)) {
      return reply.code(404).send({ ok: false, error: 'not found' });
    }
    // lgtm[js/path-injection]：name 已用白名单正则校验（^[A-Za-z0-9._-]+\.apk$），不会穿越
    const file = path.join(APK_DIR, name);
    try {
      const st = await fs.stat(file);
      if (!st.isFile()) throw new Error('not a file');
      return reply
        .type('application/vnd.android.package-archive')
        .header('Content-Length', st.size)
        .send(createReadStream(file));
    } catch {
      logger.debug({ name }, '[static] APK 不存在');
      return reply.code(404).send({ ok: false, error: 'not found' });
    }
  });
}
