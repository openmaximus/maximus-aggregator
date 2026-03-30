import crypto from "node:crypto";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

export interface AuthorizationRequest {
  url: string;
  verifier: string;
  state: string;
}

export interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string | null;
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

// --- JWT helpers ---

function extractAccountId(accessToken: string): string | null {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return null;
    const json = Buffer.from(
      parts[1].replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf8");
    const payload = JSON.parse(json);
    const id = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

function computeExpiry(expiresInSeconds: number): number {
  return Date.now() + expiresInSeconds * 1000 - 5 * 60 * 1000;
}

function validateTokenPayload(payload: unknown): asserts payload is { access_token: string; refresh_token: string; expires_in: number } {
  if (!payload || typeof payload !== "object") throw new Error("Token response is invalid");
  const p = payload as Record<string, unknown>;
  if (!p.access_token || !p.refresh_token || typeof p.expires_in !== "number") {
    throw new Error("Token response missing required fields");
  }
}

// --- Public API ---

export function getAuthorizationUrl(): AuthorizationRequest {
  const { verifier, challenge } = createPkce();
  const state = crypto.randomBytes(16).toString("hex");
  const authorizeUrl = process.env.CODEX_AUTHORIZE_URL;
  const redirectUri = process.env.CODEX_REDIRECT_URI;

  if (!authorizeUrl) throw new Error("CODEX_AUTHORIZE_URL is not set");
  if (!redirectUri) throw new Error("CODEX_REDIRECT_URI is not set");

  const url = new URL(authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "openid profile email offline_access");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "pi");

  return { url: url.toString(), verifier, state };
}

export function parseOAuthInput(input: string, fallbackState: string | null = null): { code: string; state: string | null } {
  const raw = String(input ?? "").trim();
  if (!raw) return { code: "", state: fallbackState };

  if (raw.includes("://")) {
    try {
      const parsed = new URL(raw);
      return {
        code: parsed.searchParams.get("code") ?? "",
        state: parsed.searchParams.get("state") ?? fallbackState,
      };
    } catch {
      return { code: raw, state: fallbackState };
    }
  }

  return { code: raw, state: fallbackState };
}

export async function exchangeCodeForTokens(code: string, verifier: string): Promise<CodexTokens> {
  const tokenUrl = process.env.CODEX_TOKEN_URL;
  const redirectUri = process.env.CODEX_REDIRECT_URI;

  if (!tokenUrl) throw new Error("CODEX_TOKEN_URL is not set");
  if (!redirectUri) throw new Error("CODEX_REDIRECT_URI is not set");

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  const payload = await response.json();
  validateTokenPayload(payload);

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: computeExpiry(payload.expires_in),
    accountId: extractAccountId(payload.access_token),
  };
}
