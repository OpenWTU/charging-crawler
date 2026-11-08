import pino from 'pino';
import { LOG_LEVEL, NODE_ENV } from './config.js';

/* ---------------- 内存环形缓冲（供管理后台「运行日志」页） ---------------- */

export interface LogEntry {
  seq: number;
  ts: number;
  level: number;
  msg: string;
  extra?: Record<string, unknown>;
}

const RING_MAX = 2000;
const ring: LogEntry[] = [];
let ringSeq = 0;

/** 日志级别数值 → 文字 */
export const LEVEL_TEXT: Record<number, string> = {
  10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal',
};

function pushRing(level: number, msg: string, extra?: Record<string, unknown>): void {
  ringSeq += 1;
  ring.push({ seq: ringSeq, ts: Date.now(), level, msg, extra: sanitize(extra) });
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
}

/**
 * 把日志附加字段压成**可 JSON 序列化的浅层值**。
 *
 * 必须做：pino 的请求日志会带 `req`/`res`（Fastify 对象里有 socket ↔ parser 的循环引用），
 * 原样存进环形缓冲会让 `/admin/api/logs` 在 JSON.stringify 时抛
 * "Converting circular structure to JSON"（实测 500）。
 */
function sanitize(obj: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) {
      out[k] = v ?? null;
    } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else if (v instanceof Error) {
      out[k] = v.message;
    } else if (typeof v === 'object') {
      // 只保留最常见的两个有意义摘要，其余一律降级成类型标记
      const rec = v as Record<string, unknown>;
      if (typeof rec.method === 'string' && typeof rec.url === 'string') {
        out[k] = `${rec.method} ${rec.url}`;
      } else if (typeof rec.statusCode === 'number') {
        out[k] = `status ${rec.statusCode}`;
      } else {
        out[k] = Array.isArray(v) ? `[array ${v.length}]` : '[object]';
      }
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

/**
 * 读最近日志（倒序取，返回时按时间正序）。
 *
 * @param opts.level   只保留 >= 该级别（30 = info 起）
 * @param opts.q       关键字（大小写不敏感，匹配 msg 与 extra 序列化文本）
 * @param opts.sinceSeq 增量拉取（只返回 seq 更大的）
 * @param opts.limit   最多返回条数（默认 200，上限 1000）
 */
export function recentLogs(opts: {
  level?: number;
  q?: string;
  sinceSeq?: number;
  limit?: number;
} = {}): LogEntry[] {
  const minLevel = Number(opts.level) || 0;
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 1000);
  const since = Number(opts.sinceSeq) || 0;
  const needle = String(opts.q ?? '').trim().toLowerCase();
  const out: LogEntry[] = [];
  for (let i = ring.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const e = ring[i];
    if (!e) continue;
    if (since && e.seq <= since) break;
    if (minLevel && e.level < minLevel) continue;
    if (needle) {
      const hay = `${e.msg} ${e.extra ? JSON.stringify(e.extra) : ''}`.toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    out.push(e);
  }
  return out.reverse();
}

/** 日志缓冲统计 */
export function logBufferStats(): { size: number; seq: number; max: number } {
  return { size: ring.length, seq: ringSeq, max: RING_MAX };
}

/**
 * 结构化日志（pino）。
 * 开发环境走 pino-pretty 便于阅读；生产保持 JSON 便于采集。
 * 同时通过 `hooks.logMethod` 把每条日志镜像进内存环形缓冲（dev/prod 都生效）。
 */
export const logger = pino({
  level: LOG_LEVEL,
  ...(NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
  redact: {
    // 绝不把令牌/密钥落进日志
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.token', '*.token_key'],
    censor: '[redacted]',
  },
  hooks: {
    logMethod(inputArgs: unknown[], method: (...a: unknown[]) => void) {
      try {
        const level = Number((method as unknown as { levelVal?: number }).levelVal ?? 30);
        if (inputArgs.length === 1) {
          const only = inputArgs[0];
          if (typeof only === 'string') pushRing(level, only);
          else if (only instanceof Error) pushRing(level, only.message);
          else pushRing(level, '', only as Record<string, unknown>);
        } else if (inputArgs.length >= 2) {
          const first = inputArgs[0];
          const second = inputArgs[1];
          if (typeof first === 'string') {
            // logger.info('msg %s', x)：插值交给 pino，这里只留模板
            pushRing(level, first);
          } else if (first instanceof Error) {
            pushRing(level, second === undefined ? first.message : String(second));
          } else {
            pushRing(
              level,
              typeof second === 'string' ? second : '',
              first && typeof first === 'object' ? (first as Record<string, unknown>) : undefined,
            );
          }
        }
      } catch {
        /* 环形缓冲失败绝不能影响正常打日志 */
      }
      return method.apply(this, inputArgs);
    },
  },
});

export type Logger = typeof logger;
