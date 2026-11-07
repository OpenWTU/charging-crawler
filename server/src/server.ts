/**
 * 服务入口。
 *
 * P0 阶段只提供：健康检查、优雅退出、日志。业务路由在 P2 逐步挂载。
 */
import dns from 'node:dns';
import Fastify from 'fastify';

// 国内服务器 IPv6 常不可达，DNS 只返回 IPv6 时 Node fetch 会 ECONNRESET。
// 全局 IPv4 优先，让白名单拉取等出站请求走 IPv4。
dns.setDefaultResultOrder('ipv4first');
import type { FastifyError, FastifyInstance, FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import { HOST, PORT, NODE_ENV, P2P_ENABLED, DATABASE_READONLY, AUTO_WORKER } from './config.js';
import { logger } from './logger.js';
import { closeDb, createDb, getDb, getRaw, ping } from './db/index.js';
import { migrate } from './db/migrate.js';
import { startWorker } from './domain/worker.js';
import { initP2p, stopP2p } from './domain/p2p.js';
import { registerPortsRoutes } from './routes/ports.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerStateRoutes } from './routes/state.js';
import { registerStaticRoutes } from './routes/static.js';
import { registerMiscRoutes } from './routes/misc.js';
import { registerUploadRoutes } from './routes/upload.js';
import { registerStatusRoutes } from './routes/status.js';

export type App = FastifyInstance;

export async function buildServer(opts: FastifyServerOptions = {}): Promise<App> {
  const app = Fastify({
    loggerInstance: logger,
    // 只信任 Nginx 所在网段转发的 X-Forwarded-For（容器看到的是 docker 网关地址）。
    // 用 `true` 会信任客户端任意伪造的 XFF，直接绕过 IP 限流与自动拉黑；
    // 生产需显式 TRUST_PROXY=true 才开启（配合 Nginx 反代）。
    trustProxy: process.env.TRUST_PROXY === 'true' ? '127.0.0.1,172.16.0.0/12' : false,
    bodyLimit: 8 * 1024 * 1024,
    ...opts,
  });

  await app.register(cookie);
  await registerPortsRoutes(app);
  await registerAnalyticsRoutes(app);
  await registerStateRoutes(app);
  // 静态资源 + /api/version + /api/latest
  await registerStaticRoutes(app);
  // area-coords / controllers / free-rate
  await registerMiscRoutes(app);
  // 写入：/api/snapshot、/api/device/register（P5；P8 切换后由 Node 扛写）
  await registerUploadRoutes(app);
  // 公开状态页 /status（P7，无登录）
  await registerStatusRoutes(app);

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

  // 注意：/api/version 与 /api/latest 由 routes/static.ts 提供（读真实 version.json
  // 与最新快照），这里不再放占位实现 —— 占位数据会让 App 的更新检查失效。

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

  // 读写模式下启动抓取 worker（启动即跑第一轮）
  let stopWorkerFn: (() => void) | null = null;
  if (!DATABASE_READONLY && AUTO_WORKER) {
    stopWorkerFn = startWorker();
    app.log.info('[worker] 已启动（读写模式，AUTO_WORKER=on）');
  } else if (DATABASE_READONLY) {
    app.log.info('[worker] 只读模式，不启动');
  }

  // P2P（默认开启；P2P_ENABLED=false 时跳过）
  // 注意：P2P 初始化失败绝不能让整站退出——HTTP 已经在 listen，降级成单节点继续服务
  try {
    await initP2p();
  } catch (err) {
    app.log.error({ err }, '[p2p] 初始化失败，服务继续以单节点模式运行');
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, '收到退出信号，正在关闭');
    try {
      if (stopWorkerFn) stopWorkerFn();
      await stopP2p();
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
