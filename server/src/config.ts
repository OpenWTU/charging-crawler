/**
 * 运行配置。
 *
 * 原则：所有可调项都从环境变量读，默认值与 Python 版 `cloud/config.py` 保持一致，
 * 这样双跑期两边行为相同。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** server/ 目录（源码运行时是 src/，构建后是 dist/，都向上两级到 server/） */
export const SERVER_ROOT = path.resolve(__dirname, '..');
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/* ---------------- 服务 ---------------- */

export const HOST = env('HOST', '127.0.0.1');
/** 默认 8791：刻意避开 Python 版的 8788，便于双跑对拍 */
export const PORT = envInt('PORT', 8791);
export const LOG_LEVEL = env('LOG_LEVEL', 'info');
export const NODE_ENV = env('NODE_ENV', 'development');

/* ---------------- 数据库 ---------------- */

export const DATABASE_PATH = env(
  'DATABASE_PATH',
  path.join(REPO_ROOT, 'data', 'charge.db'),
);
/** 是否只读打开（双跑期 Node 只读，避免与 Python 抢写锁） */
export const DATABASE_READONLY = envBool('DATABASE_READONLY', false);

/* ---------------- 静态资源 ---------------- */

/** 前端构建产物：与 Python 版一致指向 cloud/web/dist */
export const WEB_DIST = env('WEB_DIST', path.join(REPO_ROOT, 'cloud', 'web', 'dist'));
export const APK_DIR = env('APK_DIR', path.join(REPO_ROOT, 'cloud', 'data', 'download'));
/** APK 版本元数据（Python 用 --version-file，生产是 /var/lib/charge-cloud/version.json） */
export const VERSION_FILE = env(
  'VERSION_FILE',
  path.join(REPO_ROOT, 'cloud', 'data', 'version.json'),
);

/* ---------------- 安全 ---------------- */

/** 令牌加密主密钥文件（与 Python 版共用同一个文件） */
export const TOKEN_KEY_FILE = env('TOKEN_KEY_FILE', '/var/lib/charge-cloud/token_key');

export const ADMIN_COOKIE = 'charge_admin';
export const ADMIN_SESSION_TTL = envInt('ADMIN_SESSION_TTL', 12 * 3600);
export const ADMIN_SESSION_MAX = envInt('ADMIN_SESSION_MAX', 24 * 3600);
export const ADMIN_LOGIN_WINDOW = envInt('ADMIN_LOGIN_WINDOW', 300);
export const ADMIN_LOGIN_MAX_FAILS = envInt('ADMIN_LOGIN_MAX_FAILS', 5);

/* ---------------- 业务参数（与 Python 版一致） ---------------- */

export const PORT_STATUS_MAX = 16;
export const PORT_RE = /^[0-9A-Za-z_-]{1,8}$/;

export const CONTROLLERS_LIMIT = 500;
export const CONTROLLERS_CACHE_TTL = 30;
export const AREAS_PORTS_LIMIT = 500;
export const AREAS_PORTS_CACHE_TTL = 30;
export const AREA_PORTS_CACHE_TTL = 30;
export const AREA_PORTS_DEVICE_LIMIT = 500;
export const PILE_HISTORY_LIMIT = 120;

export const TOKEN_TRY_LIMIT = 3;
export const TOKEN_LONG_LIVED_SECONDS = 1800;

/** worker 定时抓取周期（秒）；健康判定的「过期」阈值 = 它 + 300 秒余量 */
export const WORKER_INTERVAL = 600;
export const HEALTH_STALE_SECONDS = WORKER_INTERVAL + 300;
export const HEALTH_CACHE_TTL = 30;

/* ---------------- /api/now 到达预测（与 Python 版一致） ---------------- */

export const NOW_HIST_DAYS = 14;
export const NOW_TREND_MINUTES = 30;
export const NOW_TREND_MIN_SPAN_MIN = 5;
export const NOW_ETA_MAX_MINUTES = 120;
export const NOW_TREND_SHRINK_K = 9.0;
export const NOW_FREE_KEEP_10M = 0.76;
export const NOW_WALK_M_PER_MIN = 80;
export const NOW_ZERO_HOUR_PRIOR_MIN = 30.0;
export const NOW_ZERO_AREA_PRIOR_MIN = 240.0;
export const NOW_ZERO_GLOBAL_PRIOR_EVENTS = 0.5;
export const NOW_ZERO_GLOBAL_PRIOR_MIN = 60.0;
export const NOW_ETA_MEDIAN_SCALE = 0.6;
export const PREDICTION_CACHE_TTL = 60;

export const ANALYTICS_SLOT_MINUTES = 15;
export const ANALYTICS_TREND_SLOTS = 96;
export const ANALYTICS_TREND_DAYS = 7;
export const ANALYTICS_TZ = env('ANALYTICS_TZ', 'Asia/Shanghai');
export const ANALYTICS_MISS_LIMIT = 30;

export const PORT_SYNC_INTERVAL = 0.25;
export const PORT_STALE_SECONDS = 900;
export const PORT_REFRESH_COOLDOWN = 60;

/* ---------------- P2P（默认关闭，节省内存） ---------------- */

export const P2P_ENABLED = envBool('P2P_ENABLED', false);
export const P2P_LISTEN_PORT = envInt('P2P_LISTEN_PORT', 4001);
export const P2P_BOOTSTRAP = env('P2P_BOOTSTRAP', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
