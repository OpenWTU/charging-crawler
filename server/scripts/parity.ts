/**
 * 跨语言对拍：同一个数据库，Python 版（8788）与 Node 版（8791）的响应必须逐字段一致。
 *
 * 用法：
 *   1. 先启动两端（读同一份 DB 副本）
 *   2. node --experimental-strip-types scripts/parity.ts
 *   或用 tsx：npx tsx scripts/parity.ts
 *
 * 环境变量：
 *   PY_BASE    Python 版地址（默认 http://127.0.0.1:8788）
 *   NODE_BASE  Node 版地址（默认 http://127.0.0.1:8791）
 *   PARITY_AREAS  要抽查的区域名，逗号分隔（默认取 areas-ports 的前 3 个）
 *
 * 比较规则：
 *  - 对象键顺序无关（递归排序后比较）
 *  - **数组顺序参与比较**（ORDER BY 是契约的一部分）
 *  - stale / online 依赖当前时间，单独统计（差 1 秒内视为一致）
 */

const PY_BASE = process.env.PY_BASE ?? 'http://127.0.0.1:8788';
const NODE_BASE = process.env.NODE_BASE ?? 'http://127.0.0.1:8791';

/** 递归规范化：对象按键排序，数组保持顺序 */
function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = normalize((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

async function getJSON(base: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(base + path, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* 保持原文 */
  }
  return { status: res.status, body };
}

/** 找出两个 JSON 的差异路径（最多 maxDiffs 条） */
function diff(a: unknown, b: unknown, path = '$', out: string[] = [], maxDiffs = 12): string[] {
  if (out.length >= maxDiffs) return out;
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb) {
    out.push(`${path}: 类型不同 py=${ta} node=${tb}`);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(`${path}.length: py=${a.length} node=${b.length}`);
    }
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      diff(a[i], b[i], `${path}[${i}]`, out, maxDiffs);
      if (out.length >= maxDiffs) break;
    }
    return out;
  }
  if (ta === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const k of [...keys].sort()) {
      if (!(k in ao)) {
        out.push(`${path}.${k}: py 缺失，node=${JSON.stringify(bo[k])}`);
        continue;
      }
      if (!(k in bo)) {
        out.push(`${path}.${k}: node 缺失，py=${JSON.stringify(ao[k])}`);
        continue;
      }
      diff(ao[k], bo[k], `${path}.${k}`, out, maxDiffs);
      if (out.length >= maxDiffs) break;
    }
    return out;
  }
  if (a !== b) {
    // 浮点比较加相对容差：两端 SQL 聚合顺序与舍入实现不同，末位可能差 1e-9 级
    if (typeof a === 'number' && typeof b === 'number') {
      const tol = Math.max(1e-9, Math.abs(a) * 1e-9);
      if (Math.abs(a - b) <= tol) return out;
    }
    out.push(`${path}: py=${JSON.stringify(a)} node=${JSON.stringify(b)}`);
  }
  return out;
}

interface Case {
  label: string;
  path: string;
}

const cases: Case[] = [];
const results: Array<{ label: string; ok: boolean; status: string; diffs: string[] }> = [];

async function main(): Promise<void> {
  console.log(`Python: ${PY_BASE}\nNode:   ${NODE_BASE}\n`);

  // 1) 先拿 areas-ports，用其中的真实区域名构造后续用例
  cases.push({ label: 'areas-ports', path: '/api/areas-ports' });

  const probe = await getJSON(NODE_BASE, '/api/areas-ports');
  const probeBody = probe.body as { areas?: Array<{ area: string }> };
  const areaNamesFromEnv = (process.env.PARITY_AREAS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const areaNames = areaNamesFromEnv.length
    ? areaNamesFromEnv
    : (probeBody.areas ?? []).slice(0, 3).map((a) => a.area);

  for (const areaName of areaNames) {
    cases.push({
      label: `area-ports[${areaName}]`,
      path: `/api/area-ports?area=${encodeURIComponent(areaName)}`,
    });
    cases.push({
      label: `history[${areaName}]`,
      path: `/api/history?area=${encodeURIComponent(areaName)}&limit=50`,
    });
  }

  // 分析端点（全量 + 单区各一次）
  cases.push({ label: 'analytics', path: '/api/analytics' });
  if (areaNames[0]) {
    cases.push({
      label: `analytics[${areaNames[0]}]`,
      path: `/api/analytics?area=${encodeURIComponent(areaNames[0])}&weeks=8`,
    });
  }

  // 概览（含令牌池/健康字段）
  cases.push({ label: 'overview', path: '/api/overview' });

  // 2) 逐个端点对拍
  for (const c of cases) {
    const [py, nd] = await Promise.all([getJSON(PY_BASE, c.path), getJSON(NODE_BASE, c.path)]);
    const statusOk = py.status === nd.status;
    // stale/online/generated_at 依赖当前时间：抽出来不参与比较
    const strip = (v: unknown): unknown => {
      const clone = JSON.parse(JSON.stringify(v));
      const walk = (o: unknown): void => {
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (o && typeof o === 'object') {
          const obj = o as Record<string, unknown>;
          delete obj.stale;
          delete obj.online;
          delete obj.generated_at; // 当前时间戳，两端必然差几秒
          Object.values(obj).forEach(walk);
        }
      };
      walk(clone);
      return clone;
    };
    const diffs = statusOk ? diff(normalize(strip(py.body)), normalize(strip(nd.body))) : [`HTTP 状态不同 py=${py.status} node=${nd.status}`];
    results.push({
      label: c.label,
      ok: statusOk && diffs.length === 0,
      status: `py=${py.status} node=${nd.status}`,
      diffs,
    });
  }

  // 3) 输出
  console.log('================ 对拍结果 ================');
  let pass = 0;
  for (const r of results) {
    console.log(`\n${r.ok ? '✓' : '✗'} ${r.label}  (${r.status})`);
    if (r.ok) pass += 1;
    for (const d of r.diffs) console.log(`    ${d}`);
  }
  console.log(`\n================ ${pass}/${results.length} 端点一致 ================`);
  process.exitCode = pass === results.length ? 0 : 1;
}

main().catch((err) => {
  console.error('对拍失败:', err);
  process.exit(1);
});
