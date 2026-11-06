/**
 * 平台 API 客户端（复刻 crawler/api.py）。
 *
 * ⚠️ 生产 worker 用；测试**绝不真实调用** ap3202（避免触发平台风控），
 * 签名算法靠 sign.ts 的对拍测试验证，HTTP 调用靠注入 mock。
 */
import { buildHeaders } from './sign.js';

const BASE = 'https://ap3202.haokuaichong.cn/quickuser50/';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 ' +
  'MicroMessenger/7.0.20.1781 XWEB/25819';

export class ApiError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

export class AuthExpired extends ApiError {
  constructor(message: string, code?: number) {
    super(message, code);
  }
}

/** 认证失效判定（与 Python _is_auth_error 一致） */
export function isAuthError(exc: unknown): boolean {
  if (exc instanceof AuthExpired) return true;
  return (exc as ApiError)?.code === 401;
}

function encodeQuery(params: Record<string, unknown>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
}

export interface CallResult {
  code?: number;
  msg?: string;
  data?: unknown;
  [k: string]: unknown;
}

export async function call(
  path: string,
  params: Record<string, unknown> = {},
  opts: { token?: string; userId?: string; appid?: string; timeout?: number } = {},
): Promise<CallResult> {
  const { token = '', userId = '', appid = '', timeout = 15 } = opts;
  const query = encodeQuery(params);
  const url = `${BASE}${path}${query ? `?${query}` : ''}`;
  const headers: Record<string, string> = buildHeaders(url, userId, token, appid) as unknown as Record<
    string,
    string
  >;
  headers['User-Agent'] = USER_AGENT;

  const res = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeout * 1000),
  });
  const body = await res.text();

  if (res.status === 401) {
    throw new AuthExpired(`登录态失效（HTTP 401）`, 401);
  }
  let data: CallResult;
  try {
    data = JSON.parse(body);
  } catch {
    throw new ApiError(`返回不是 JSON: ${JSON.stringify(body.slice(0, 200))}`);
  }
  if (data.code === 20001 || data.code === 70006 || data.code === 70004) {
    throw new AuthExpired(`登录态失效（code=${data.code}）：${data.msg}`, data.code);
  }
  return data;
}

export { BASE };
