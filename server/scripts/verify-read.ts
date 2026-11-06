/**
 * P1 数据层验证：用 Kysely 读生产库副本，结果必须与 Python 版一致。
 *
 * 用法：
 *   DATABASE_PATH=/path/to/charge.db DATABASE_READONLY=1 npx tsx scripts/verify-read.ts
 *
 * 验收标准（与 Python 侧实测值对照）：
 *   port_states       438
 *   controllers        39
 *   areas              39
 *   pile_samples    19485
 *   area_samples    30822
 *   snapshots         791
 *   status 分布：充电中 400 / 空闲 38
 *   分组分布：busy 400 / free 38
 */
import { createDb, closeDb, ping, sql } from '../src/db/index.js';
import { PORT_STATUS_GROUPS, statusGroup } from '../src/domain/port-status.js';
import { logger } from '../src/logger.js';

interface Result {
  label: string;
  actual: unknown;
  expected: unknown;
  ok: boolean;
}

const results: Result[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ label, actual, expected, ok });
}

async function main(): Promise<void> {
  const db = createDb(undefined, true); // 只读打开副本

  const { tables } = await ping(db);
  logger.info({ tables }, '读到的表数量');

  // 1) 各表行数
  const counts = await sql<{ t: string; n: number }>`
    SELECT 'port_states' AS t, COUNT(*) AS n FROM port_states
    UNION ALL SELECT 'controllers', COUNT(*) FROM controllers
    UNION ALL SELECT 'areas', COUNT(*) FROM areas
    UNION ALL SELECT 'pile_samples', COUNT(*) FROM pile_samples
    UNION ALL SELECT 'area_samples', COUNT(*) FROM area_samples
    UNION ALL SELECT 'snapshots', COUNT(*) FROM snapshots
  `.execute(db);
  const countMap: Record<string, number> = {};
  for (const r of counts.rows) countMap[r.t] = Number(r.n);

  check('port_states', countMap.port_states, 438);
  check('controllers', countMap.controllers, 39);
  check('areas', countMap.areas, 39);
  check('pile_samples', countMap.pile_samples, 19485);
  check('area_samples', countMap.area_samples, 30822);
  check('snapshots', countMap.snapshots, 791);

  // 2) status 分布（原文）
  const byStatus = await sql<{ status: string; n: number }>`
    SELECT status, COUNT(*) AS n FROM port_states GROUP BY status ORDER BY n DESC
  `.execute(db);
  const statusMap: Record<string, number> = {};
  for (const r of byStatus.rows) statusMap[String(r.status)] = Number(r.n);
  check('status 分布', statusMap, { 充电中: 400, 空闲: 38 });

  // 3) status_group 分布（应由触发器维护）
  const byGroup = await sql<{ status_group: string; n: number }>`
    SELECT status_group, COUNT(*) AS n FROM port_states GROUP BY status_group
  `.execute(db);
  const groupMap: Record<string, number> = {};
  for (const r of byGroup.rows) groupMap[String(r.status_group)] = Number(r.n);
  check('status_group 分布', groupMap, { busy: 400, free: 38 });

  // 4) 用 Node 侧的映射重算分组，必须与库里的 status_group 完全一致（0 处漂移）
  const rows = await sql<{ device_hex: string; port: string; status: string; status_group: string }>`
    SELECT device_hex, port, status, status_group FROM port_states
  `.execute(db);
  let drift = 0;
  const driftSamples: string[] = [];
  for (const r of rows.rows) {
    const expected = statusGroup(r.status);
    if (expected !== r.status_group) {
      drift += 1;
      if (driftSamples.length < 5) {
        driftSamples.push(`${r.device_hex}/${r.port} status=${r.status} db=${r.status_group} node=${expected}`);
      }
    }
  }
  check('分组漂移数（Node 映射 vs 库内触发器）', drift, 0);
  if (drift > 0) logger.error({ driftSamples }, '分组漂移样例');

  // 5) controllers 与 areas 的关联读取（P2 的 /api/areas-ports 会用到）
  const joined = await sql<{ device_hex: string; code: string; area_name: string; ports: number }>`
    SELECT c.device_hex, c.code, c.area_name, COUNT(p.port) AS ports
      FROM controllers c
      LEFT JOIN port_states p ON p.device_hex = c.device_hex
     GROUP BY c.device_hex
     ORDER BY c.device_hex
  `.execute(db);
  const totalPorts = joined.rows.reduce((a, r) => a + Number(r.ports), 0);
  check('controllers LEFT JOIN port_states 汇总端口数', totalPorts, 438);
  check('有区名的控制器数', joined.rows.filter((r) => r.area_name).length, 39);

  // 6) 端口状态白名单覆盖率（本库只出现 2 种，其余 20 种是平台可能返回的）
  const distinct = Object.keys(statusMap);
  const known = distinct.filter((s) => Object.hasOwn(PORT_STATUS_GROUPS, s));
  check('出现的状态全部在白名单内', known.length, distinct.length);

  // ---- 输出 ----
  const pass = results.filter((r) => r.ok).length;
  console.log('\n================ 验证结果 ================');
  for (const r of results) {
    console.log(
      `  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(42)} 实际=${JSON.stringify(r.actual)}` +
        (r.ok ? '' : `  期望=${JSON.stringify(r.expected)}`),
    );
  }
  console.log(`\n  ${pass}/${results.length} 项通过`);
  await closeDb();
  process.exitCode = pass === results.length ? 0 : 1;
}

main().catch((err) => {
  logger.fatal({ err }, '验证失败');
  process.exit(1);
});
