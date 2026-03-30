export interface MappedError {
  status: number;
  type: "authentication_error" | "permission_error" | "rate_limit_error" | "upstream_error";
  code: "token_expired" | "invalid_token" | "access_denied" | "rate_limited" | "provider_error";
  message: string;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export function mapProviderError(err: unknown): MappedError {
  const message = err instanceof Error ? err.message : String(err);

  // Token refresh failures from credentials files
  if (err instanceof AuthError || /token refresh failed|invalid_grant|refresh token/i.test(message)) {
    return { status: 401, type: "authentication_error", code: "token_expired", message };
  }

  // Parse HTTP status from upstream error messages e.g. "Codex API error 401: ..."
  const statusMatch = message.match(/\b(401|403|429)\b/);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status === 401) return { status: 401, type: "authentication_error", code: "invalid_token", message };
    if (status === 403) return { status: 403, type: "permission_error", code: "access_denied", message };
    if (status === 429) return { status: 429, type: "rate_limit_error", code: "rate_limited", message };
  }

  // Anthropic SDK surfaces auth errors with these strings
  if (/authentication_error|invalid.*api.?key|invalid.*token/i.test(message)) {
    return { status: 401, type: "authentication_error", code: "invalid_token", message };
  }
  if (/permission|forbidden/i.test(message)) {
    return { status: 403, type: "permission_error", code: "access_denied", message };
  }
  if (/rate.?limit|too many request/i.test(message)) {
    return { status: 429, type: "rate_limit_error", code: "rate_limited", message };
  }

  return { status: 502, type: "upstream_error", code: "provider_error", message };
}
