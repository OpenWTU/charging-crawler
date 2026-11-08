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
  ring.push({ seq: ringSeq, ts: Date.now(), level, msg, extra });
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
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
