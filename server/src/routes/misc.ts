/**
 * 杂项只读接口：/api/area-coords、/api/controllers、/api/free-rate。
 *
 * ⚠️ 与 Python 版逐字段一致：
 *   area-coords  → {ok, areas:[{name,lat,lng}]}
 *   controllers  → {ok, count, controllers:[{area_name,device_hex,code,qr_device_no}]}
 *   free-rate    → {ok, days, total_samples, points:[{hour,samples,free_rate}]}
 */
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { CONTROLLERS_LIMIT, P2P_WHITELIST_CACHE, P2P_WHITELIST_DEFAULT } from '../config.js';
import { getDb } from '../db/index.js';
import { pyRound } from '../domain/analytics.js';
import { fmtDateTime } from '../domain/prediction.js';

export async function registerMiscRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  /** 区域坐标：只回有坐标的区域 */
  app.get('/api/area-coords', async (_req, reply) => {
    const res = await sql<{ name: string; lat: number; lng: number }>`
      SELECT name, lat, lng FROM areas WHERE lat IS NOT NULL AND lng IS NOT NULL
    `.execute(db);
    return reply.send({
      ok: true,
      areas: res.rows.map((r) => ({ name: String(r.name), lat: r.lat, lng: r.lng })),
    });
  });

  /**
   * 节点目录（GitHub 代理）。
   *
   * App 的 NodeDiscovery 原本直连 `api.github.com/.../contents/nodes.json`，
   * 而 api.github.com 在国内经常被阻断/极慢 —— 表现为「节点发现」每次启动都要
   * 干等 3 秒超时，然后回退默认节点。这里由服务器代取并返回同一份 JSON，
   * App 只要问自己的服务器（几十毫秒）就能拿到目录。
   *
   * 数据源按可用性依次兜底：
   *   ① P2P_WHITELIST_CACHE（数据卷缓存，服务器自己从 GitHub 拉过的那份）
   *   ② P2P_WHITELIST_DEFAULT（镜像内随版本发布的副本）
   *   ③ jsDelivr CDN 现场拉一次（前两级都空时）
   * 两者都是 `{ nodes: [...] }`，与 GitHub 上的格式完全一致，App 可直接解析。
   */
  app.get('/api/nodes.json', async (_req, reply) => {
    for (const file of [P2P_WHITELIST_CACHE, P2P_WHITELIST_DEFAULT]) {
      try {
        const text = fs.readFileSync(file, 'utf8');
        // 校验是合法 JSON 再下发，避免把半截文件/损坏缓存发给客户端
        const parsed = JSON.parse(text) as { nodes?: unknown };
        if (!Array.isArray(parsed.nodes)) continue;
        return reply
          .header('Cache-Control', 'public, max-age=300')
          .type('application/json; charset=utf-8')
          .send(JSON.stringify(parsed));
      } catch {
        /* 换下一个来源 */
      }
    }
    // 两级本地来源都空（比如全新部署、数据卷刚清空）：现场问一次 jsDelivr。
    // 不用 api.github.com —— 服务器所在国内网络同样经常连不上它。
    try {
      const r = await fetch(
        'https://cdn.jsdelivr.net/gh/OpenWTU/charging-crawler@main/server/p2p/nodes.json',
        { signal: AbortSignal.timeout(5000) },
      );
      if (r.ok) {
        const parsed = (await r.json()) as { nodes?: unknown };
        if (Array.isArray(parsed.nodes)) {
          return reply
            .header('Cache-Control', 'public, max-age=300')
            .type('application/json; charset=utf-8')
            .send(JSON.stringify(parsed));
        }
      }
    } catch {
      /* 连 CDN 都不通：下面返回 404，App 会继续试它自己的兜底源 */
    }
    return reply.code(404).send({ ok: false, error: 'nodes_unavailable', nodes: [] });
  });

  /** 控制器清单：code 非空，按 area_name + device_hex 排序，上限 500 */
  app.get('/api/controllers', async (_req, reply) => {
    const res = await sql<{
      area_name: string | null;
      device_hex: string;
      code: string | null;
      qr_device_no: string | null;
    }>`
      SELECT area_name, device_hex, code, qr_device_no
        FROM controllers
       WHERE code IS NOT NULL AND code <> ''
       ORDER BY area_name, device_hex
       LIMIT ${CONTROLLERS_LIMIT}
    `.execute(db);
    const controllers = res.rows.map((r) => ({
      area_name: r.area_name,
      device_hex: r.device_hex,
      code: r.code,
      qr_device_no: r.qr_device_no,
    }));
    return reply.send({ ok: true, count: controllers.length, controllers });
  });

  /** 分时段空闲率：按小时聚合近 N 天的样本 */
  app.get('/api/free-rate', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    let days = 14;
    const raw = Number.parseInt(q.days ?? '', 10);
    if (Number.isFinite(raw)) days = Math.max(1, Math.min(raw, 30));

    const cutoff = fmtDateTime(new Date(Date.now() - days * 86400 * 1000));

    const totalRes = await sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM area_samples WHERE received_at >= ${cutoff}
    `.execute(db);
    const rowsRes = await sql<{ hour: number; samples: number; free: number | null }>`
      SELECT CAST(strftime('%H', received_at) AS INTEGER) AS hour,
             COUNT(*) AS samples,
             SUM(CASE WHEN idle > 0 THEN 1 ELSE 0 END) AS free
        FROM area_samples WHERE received_at >= ${cutoff}
       GROUP BY 1
    `.execute(db);

    const buckets = new Map<number, [number, number]>();
    for (let h = 0; h < 24; h += 1) buckets.set(h, [0, 0]);
    for (const r of rowsRes.rows) {
      buckets.set(Number(r.hour), [Number(r.samples), Number(r.free ?? 0)]);
    }
    const points: Array<{ hour: number; samples: number; free_rate: number | null }> = [];
    for (let h = 0; h < 24; h += 1) {
      const [samples, free] = buckets.get(h)!;
      points.push({
        hour: h,
        samples,
        free_rate: samples > 0 ? pyRound(free / samples, 4) : null,
      });
    }
    return reply.send({
      ok: true,
      days,
      total_samples: Number(totalRes.rows[0]?.n ?? 0),
      points,
    });
  });
}
