/**
 * 角色门控 composable。
 *
 * AdminShell 用 provide 下发当前角色能力；页面用 useRole() 取，用来隐藏「点了必然 403」的写操作。
 * 默认值 true：如果某页面被单独挂载（无 provider），保持原有行为，不会误伤。
 *
 * 注意：这只是**体验层**——真正的边界在后端 requireRole。前端隐藏是为了不让人点了没反应。
 */
import { inject, ref } from 'vue';

export function useRole() {
  const role = inject('adminRole', ref('super'));
  const canWrite = inject('canWrite', ref(true));
  const isSuper = inject('isSuper', ref(true));
  return { role, canWrite, isSuper };
}

/** 后端 super 专属的设置项（配置中心据此隐藏保存按钮） */
export const SUPER_ONLY_SETTINGS = [
  'p2p_trust_non_whitelist',
  'p2p_validate_mode',
  'p2p_validate_threshold',
  'p2p_validate_window_sec',
  'p2p_validate_min_areas',
  'p2p_extra_peers',
];
