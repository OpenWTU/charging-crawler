/**
 * 端口状态分组常量。
 *
 * ⚠️ 本文件与 `cloud/config.py` 的 `PORT_STATUS_GROUPS` 必须逐项一致。
 * 修改任何一边都必须同步另一边，否则 Node 版与 Python 版对拍会不一致。
 * 校验方式：`npm run verify:constants`（比对两边导出的键值对）。
 */

export type PortGroup = 'free' | 'busy' | 'unavailable' | 'unknown';

/** 端口状态 → 分组映射（22 项，与 Python 版逐项一致） */
export const PORT_STATUS_GROUPS = {
  空闲: 'free',
  充电中: 'busy',
  未充占用: 'busy',
  已充满: 'busy',
  充满占用: 'busy',
  浮充: 'busy',
  占用: 'busy',
  端口故障: 'unavailable',
  故障: 'unavailable',
  离线: 'unavailable',
  维护: 'unavailable',
  禁用: 'unavailable',
  绑定: 'unavailable',
  绑定端口: 'unavailable',
  禁用端口: 'unavailable',
  存储器损坏: 'unavailable',
  安全门卡住: 'unavailable',
  保险丝烧断: 'unavailable',
  继电器粘连: 'unavailable',
  门磁芯片损坏: 'unavailable',
  '预检-负载短路': 'unavailable',
  刷卡芯片损坏故障: 'unavailable',
} as const satisfies Record<string, PortGroup>;

export type PortStatus = keyof typeof PORT_STATUS_GROUPS;

/** 白名单（顺序与 Python 版一致，用于稳定输出与对拍） */
export const PORT_STATUSES: readonly string[] = Object.keys(PORT_STATUS_GROUPS);

/** 反查：分组 → 该组下所有状态（保持插入顺序） */
export const STATUSES_BY_GROUP: Record<PortGroup, readonly string[]> = {
  free: ['空闲'],
  busy: ['充电中', '未充占用', '已充满', '充满占用', '浮充', '占用'],
  unavailable: [
    '端口故障', '故障', '离线', '维护', '禁用', '绑定', '绑定端口', '禁用端口',
    '存储器损坏', '安全门卡住', '保险丝烧断', '继电器粘连', '门磁芯片损坏',
    '预检-负载短路', '刷卡芯片损坏故障',
  ],
  unknown: [],
};

/** 无法识别的状态在清洗时保留原文，但分组归为 unknown */
export function statusGroup(status: string | null | undefined): PortGroup {
  if (!status) return 'unknown';
  return (PORT_STATUS_GROUPS as Record<string, PortGroup>)[status] ?? 'unknown';
}

/** 是否是白名单内的已知状态 */
export function isKnownStatus(status: string | null | undefined): boolean {
  return !!status && Object.hasOwn(PORT_STATUS_GROUPS, status);
}
