import crypto from "node:crypto";

// Decoded at runtime — not stored as plaintext.
const CLIENT_ID = Buffer.from("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl", "base64").toString("utf-8");

export interface ClaudeAuthorizationRequest {
  url: string;
  verifier: string;
}

export interface ClaudeTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

// --- PKCE helpers ---

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(crypto.randomBytes(32));
  const challenge = base64UrlEncode(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// --- Public API ---

export function getAuthorizationUrl(): ClaudeAuthorizationRequest {
  const authorizeUrl = process.env.CLAUDE_AUTHORIZE_URL;
  const redirectUri = process.env.CLAUDE_REDIRECT_URI;

  if (!authorizeUrl) throw new Error("CLAUDE_AUTHORIZE_URL is not set");
  if (!redirectUri) throw new Error("CLAUDE_REDIRECT_URI is not set");

  const { verifier, challenge } = createPkce();

  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "org:create_api_key user:profile user:inference",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });

  return { url: `${authorizeUrl}?${params.toString()}`, verifier };
}

export async function exchangeCodeForTokens(code: string, verifier: string): Promise<ClaudeTokens> {
  const tokenUrl = process.env.CLAUDE_TOKEN_URL;
  const redirectUri = process.env.CLAUDE_REDIRECT_URI;

  if (!tokenUrl) throw new Error("CLAUDE_TOKEN_URL is not set");
  if (!redirectUri) throw new Error("CLAUDE_REDIRECT_URI is not set");

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      state: verifier,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  const data = await response.json() as { access_token: string; refresh_token: string; expires_in: number };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

export async function refreshClaudeToken(refreshTokenValue: string): Promise<ClaudeTokens> {
  const tokenUrl = process.env.CLAUDE_TOKEN_URL;
  if (!tokenUrl) throw new Error("CLAUDE_TOKEN_URL is not set");

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshTokenValue,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Token refresh failed: ${response.status} ${text}`);
  }

  const data = await response.json() as { access_token: string; refresh_token: string; expires_in: number };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

export function isTokenExpired(expiresAt: number): boolean {
  return Date.now() >= expiresAt;
}
