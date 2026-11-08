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
export const NODE_ENV = env('NODE_ENV', 'production');

/* ---------------- 数据库 ---------------- */

export const DATABASE_PATH = env(
  'DATABASE_PATH',
  path.join(REPO_ROOT, 'data', 'charge.db'),
);
/** 是否只读打开（双跑期 Node 只读，避免与 Python 抢写锁） */
export const DATABASE_READONLY = envBool('DATABASE_READONLY', false);

/* ---------------- 静态资源 ---------------- */

/** 前端构建产物（webui/dist） */
export const WEB_DIST = env('WEB_DIST', path.join(REPO_ROOT, 'webui', 'dist'));
export const APK_DIR = env('APK_DIR', path.join(REPO_ROOT, 'data', 'download'));
/** APK 版本元数据（生产是 /var/lib/charge-cloud/version.json，Docker 里 /data/version.json） */
export const VERSION_FILE = env(
  'VERSION_FILE',
  path.join(REPO_ROOT, 'data', 'version.json'),
);

/* ---------------- 安全 ---------------- */

/** 令牌加密主密钥文件（与 Python 版共用同一个文件） */
export const TOKEN_KEY_FILE = env('TOKEN_KEY_FILE', '/var/lib/charge-cloud/token_key');


/* ---------------- 业务参数（与 Python 版一致） ---------------- */

export const PORT_STATUS_MAX = 16;
export const PORT_RE = /^[0-9A-Za-z_-]{1,8}$/;

export const CONTROLLERS_LIMIT = 500;
export const AREAS_PORTS_LIMIT = 500;
export const AREA_PORTS_DEVICE_LIMIT = 500;
export const PILE_HISTORY_LIMIT = 120;

export const TOKEN_TRY_LIMIT = 3;
export const TOKEN_LONG_LIVED_SECONDS = 1800;

/** worker 定时抓取周期（秒）；健康判定的「过期」阈值 = 它 + 300 秒余量 */
export const WORKER_INTERVAL = 600;
export const HEALTH_STALE_SECONDS = WORKER_INTERVAL + 300;

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

export const PORT_STALE_SECONDS = 900;

/* ---------------- P2P（默认开启） ---------------- */

export const P2P_ENABLED = envBool('P2P_ENABLED', true);
export const P2P_LISTEN_PORT = envInt('P2P_LISTEN_PORT', 4001);
export const P2P_BOOTSTRAP = env('P2P_BOOTSTRAP', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
/** 节点私钥文件（Ed25519 hex，稳定 peerId 的来源；不进仓库，留在服务器本地） */
export const P2P_KEY_FILE = env('P2P_KEY_FILE', '/var/lib/charge-cloud/p2p_key');
/** 节点名称（状态页卡片显示，便于识读；默认取环境变量或 peerId 前 8 位） */
export const NODE_NAME = env('NODE_NAME', '');
/** 节点 HTTP 地址（状态页切换节点用；App 切换后直连这个 URL） */
export const NODE_URL = env('NODE_URL', '');
/** 本节点公网 P2P 地址（如 /ip4/1.2.3.4/tcp/4001），心跳广播给其他节点用于互连 */
export const NODE_P2P_ADDR = env('NODE_P2P_ADDR', '');

/**
 * 是否信任**非白名单节点**共享的数据。
 *
 * 默认 `false`：只接受 nodes.json 里已登记节点的快照/心跳，其余节点的包直接丢弃。
 * 设为 `true`：任何能连上来的 libp2p 节点（含 mDNS 发现的局域网节点）的数据都接受。
 *
 * 注意：这只影响「消息是否被采纳」，不影响连接本身——任何节点在任何配置下都能加入
 * P2P 网络、能被 /status 看到、App 也能手动切过去；区别只是它的数据会不会落库。
 */
export const P2P_TRUST_NON_WHITELIST = envBool('P2P_TRUST_NON_WHITELIST', false);
/**
 * 节点目录 + peerId 白名单（同一份文件，App 与服务器共用）。
 * 用 GitHub contents API（api.github.com 不被 SNI 阻断）。
 */
export const P2P_WHITELIST_URL = env(
  'P2P_WHITELIST_URL',
  'https://api.github.com/repos/OpenWTU/charging-crawler/contents/server/p2p/nodes.json',
);
/** 白名单本地缓存（离线时兜底） */
export const P2P_WHITELIST_CACHE = env(
  'P2P_WHITELIST_CACHE',
  '/var/lib/charge-cloud/p2p_peers.json',
);
/** 镜像内默认白名单（随版本发布，远程/缓存都拿不到时用它） */
export const P2P_WHITELIST_DEFAULT = env(
  'P2P_WHITELIST_DEFAULT',
  '/app/default-peers.json',
);
export const P2P_MDNS = envBool('P2P_MDNS', false);

/* ---------------- 服务端抓取 worker ---------------- */

/** 读写模式下是否自动启动抓取 worker（P8 切换后默认开） */
export const AUTO_WORKER = envBool('AUTO_WORKER', true);

/** 后端版本（CI 构建时注入 tag；本地开发默认 dev） */
export const SERVER_VERSION = env('SERVER_VERSION', 'dev');

/* ---------------- 设备注册 ---------------- */

/**
 * 设备注册令牌（可选）。
 *
 * 配置后 POST /api/device/register 必须带 `x-register-token` 头且值相等，
 * 否则 403——防止任何人随手注册设备后污染公共数据。
 *
 * **留空表示不校验**（默认）：这样已经装机的旧版 App（不带该头）仍能注册。
 * 等新版 App 普及后再设该变量即可，无需改代码。
 */

/* ---------------- 管理后台 ---------------- */

/**
 * 初始管理员口令（可选）。**仅在 `admin_users` 表为空时**用来创建第一个 super 账号，
 * 并标记「首次登录必须改密」。未配置则不创建任何账号（不会留下默认口令）。
 */
export const ADMIN_INIT_PASSWORD = env('ADMIN_INIT_PASSWORD', '');

/** 初始管理员的用户名（默认 admin） */
export const ADMIN_INIT_USERNAME = env('ADMIN_INIT_USERNAME', 'admin').trim() || 'admin';

/** 会话签名密钥（建议 ≥16 位随机串；缺失时进程内随机，重启即失效所有会话） */
export const ADMIN_SESSION_SECRET = env('ADMIN_SESSION_SECRET', '');
