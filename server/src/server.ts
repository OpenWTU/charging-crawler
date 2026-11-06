/**
 * 服务入口。
 *
 * P0 阶段只提供：健康检查、优雅退出、日志。业务路由在 P2 逐步挂载。
 */
import Fastify from 'fastify';
import type { FastifyError, FastifyInstance, FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import { HOST, PORT, NODE_ENV, P2P_ENABLED, DATABASE_READONLY } from './config.js';
import { logger } from './logger.js';
import { closeDb, createDb, getDb, getRaw, ping } from './db/index.js';
import { migrate } from './db/migrate.js';
import { registerPortsRoutes } from './routes/ports.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerStateRoutes } from './routes/state.js';

export type App = FastifyInstance;

export async function buildServer(opts: FastifyServerOptions = {}): Promise<App> {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true, // Nginx 反代：用 X-Forwarded-For / X-Real-IP
    bodyLimit: 8 * 1024 * 1024,
    ...opts,
  });

  await app.register(cookie);
  await registerPortsRoutes(app);
  await registerAnalyticsRoutes(app);
  await registerStateRoutes(app);

  // ---- 健康检查（Python 版 /health 的等价实现） ----
  app.get('/health', async (_req, reply) => {
    try {
      const { ok, tables } = await ping();
      return reply.code(ok ? 200 : 503).send({
        ok,
        tables,
        p2p: P2P_ENABLED,
        ts: new Date().toISOString(),
      });
    } catch (err) {
      app.log.error({ err }, 'health 检查失败');
      return reply.code(503).send({ ok: false, error: 'db_unavailable' });
    }
  });

  // ---- 版本（P2 补全为与 Python 版一致的字段） ----
  app.get('/api/version', async (_req, reply) => {
    return reply.send({
      versionCode: 0,
      versionName: '0.0.0-node',
      note: 'Node 重构版（P0 骨架）',
    });
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    req.log.error({ err, url: req.url }, '未捕获错误');
    // 与 Python 版一致：不向客户端泄露堆栈
    return reply.code(err.statusCode ?? 500).send({ error: 'internal_error' });
  });

  app.setNotFoundHandler((req, reply) => {
    return reply.code(404).send({ error: 'not_found', path: req.url });
  });

  return app;
}

async function main(): Promise<void> {
  createDb();

  // 与 Python 版 init_db() 一致：启动即迁移（幂等）。
  // 只读模式（双跑期读生产库）绝不能改 schema，直接跳过。
  if (!DATABASE_READONLY) {
    try {
      const res = migrate(getRaw());
      logger.info(
        { applied: res.applied.length, skipped: res.skipped.length },
        '[migrate] 启动迁移完成',
      );
    } catch (err) {
      logger.fatal({ err }, '[migrate] 启动迁移失败');
      throw err;
    }
  } else {
    logger.info('[migrate] 只读模式，跳过迁移');
  }

  logDbSummary();
  const app = await buildServer();
  await app.listen({ host: HOST, port: PORT });
  app.log.info({ host: HOST, port: PORT, env: NODE_ENV }, 'charge-server 已启动');

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, '收到退出信号，正在关闭');
    try {
      await app.close();
      await closeDb();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

function logDbSummary(): void {
  try {
    const db = getDb();
    void ping(db).then(({ tables }) => {
      logger.info({ tables }, '[db] 就绪');
    });
  } catch (err) {
    logger.error({ err }, '[db] 初始化失败（服务仍会启动，/health 会报 503）');
  }
}

// 直接执行时启动服务；被测试 import 时不自动监听端口
const isDirectRun =
  !!process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isDirectRun || (NODE_ENV !== 'test' && !process.env.VITEST)) {
  main().catch((err) => {
    logger.fatal({ err }, '启动失败');
    process.exit(1);
  });
}
