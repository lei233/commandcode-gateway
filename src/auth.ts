/**
 * 解析 Authorization / x-api-key 请求头，归一化当前请求的 CommandCode 凭据。
 * 在头值中匹配 `user_` 前缀 token，`token_user_...` 等形式经由同一段
 * 子串匹配天然归一为 `user_...`。
 */

/** 从单个头值中提取 `user_...` token；无匹配返回 undefined。 */
function extractUserToken(headerValue: string | undefined): string | undefined {
  if (typeof headerValue !== 'string' || headerValue === '') return undefined
  const match = headerValue.match(/user_[a-zA-Z0-9_-]+/)
  return match?.[0]
}

export type CredentialResult =
  | { ok: true; apiKey: string }
  | { ok: false; status: 400 | 401; message: string }

/**
 * 归一当前请求凭据。两个头都携带 `user_` token 且归一结果不一致时返回 400；
 * 任一头可提取即成功；都不可提取返回 401。
 */
export function normalizeCredentials(
  authorization: string | undefined,
  xApiKey: string | undefined,
): CredentialResult {
  const fromAuth = extractUserToken(authorization)
  const fromKey = extractUserToken(xApiKey)

  if (fromAuth !== undefined && fromKey !== undefined && fromAuth !== fromKey) {
    return {
      ok: false,
      status: 400,
      message: 'Conflicting credentials in Authorization and x-api-key headers.',
    }
  }
  const apiKey = fromAuth ?? fromKey
  if (apiKey === undefined) {
    return {
      ok: false,
      status: 401,
      message: 'Missing API key. Send it in Authorization: Bearer <key> or x-api-key header.',
    }
  }
  return { ok: true, apiKey }
}
