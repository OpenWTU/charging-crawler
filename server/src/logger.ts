import pino from 'pino';
import { LOG_LEVEL, NODE_ENV } from './config.js';

/**
 * 结构化日志（pino）。
 * 开发环境走 pino-pretty 便于阅读；生产保持 JSON 便于采集。
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
});

export type Logger = typeof logger;
