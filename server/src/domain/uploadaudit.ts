/**
 * 上传审计：每条 `/api/snapshot`、`/api/device/register` 请求写一行 `upload_audit`。
 *
 * 之前这张表只有建表、清理与查询代码，**从未写入**（管理后台审计页因此一直是空的）。
 * 现在由 `upload.ts` 的 `onResponse` 钩子统一落库：钩子保证「每个请求一行」，
 * handler 里只需在关键分支设置 `req.uploadReason` 提供细分原因。
 *
 * 写入失败绝不影响主流程。
 */
import type { FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { getDb } from '../db/index.js';
import { logger } from '../logger.js';

export type UploadKind = 'snapshot' | 'register';

export interface UploadMeta {
  kind: UploadKind;
  /** 细分原因：ok / bad_sig / bad_ts / replay / invalid / pending / banned / rate_limited / error … */
  reason: string;
  deviceId?: string | null;
  detail?: string | null;
}

/** 在 handler 里挂原因（钩子会读） */
export function markUpload(req: FastifyRequest, reason: string, extra?: { deviceId?: string | null; detail?: string | null }): void {
  const r = req as FastifyRequest & { uploadMeta?: UploadMeta };
  if (!r.uploadMeta) {
    r.uploadMeta = { kind: req.url.startsWith('/api/device/register') ? 'register' : 'snapshot', reason };
  } else {
    r.uploadMeta.reason = reason;
  }
  if (extra?.deviceId !== undefined) r.uploadMeta.deviceId = extra.deviceId;
  if (extra?.detail !== undefined) r.uploadMeta.detail = extra.detail;
}

function nowLocal(): string {
  const d = new Date();
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 落库（不抛错） */
export async function writeUploadAudit(
  req: FastifyRequest,
  statusCode: number,
  size: number,
  meta: UploadMeta,
): Promise<void> {
  try {
    const ua = String(req.headers['user-agent'] ?? '').slice(0, 200);
    const result = statusCode < 300 ? 'ok' : `http_${statusCode}`;
    const detail = JSON.stringify({
      reason: meta.reason,
      device_id: meta.deviceId ?? null,
      note: meta.detail ?? null,
    });
    await sql`
      INSERT INTO upload_audit (ts, ip, ua, size, result, detail)
      VALUES (${nowLocal()}, ${req.ip ?? null}, ${ua}, ${size}, ${result}, ${detail})
    `.execute(getDb());
  } catch (e) {
    logger.warn({ err: e }, '[upload_audit] 写入失败（不影响主流程）');
  }
}
