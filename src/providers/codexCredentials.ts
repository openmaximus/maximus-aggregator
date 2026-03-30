import { AuthError } from "../lib/errorMapper";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

interface CodexCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
}

// In-memory store — seeded from env vars at startup.
let store: CodexCredentials = {
  accessToken: process.env.CODEX_ACCESS_TOKEN ?? "",
  refreshToken: process.env.CODEX_REFRESH_TOKEN ?? "",
  expiresAt: Number(process.env.CODEX_EXPIRES_AT ?? 0),
  accountId: process.env.CODEX_ACCOUNT_ID ?? "",
};

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

export async function getCodexCredentials(): Promise<CodexCredentials> {
  if (Date.now() < store.expiresAt) return store;

  const tokenUrl = process.env.CODEX_TOKEN_URL;
  if (!tokenUrl) throw new Error("CODEX_TOKEN_URL is not set");

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: store.refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new AuthError(`Token refresh failed: ${response.status} ${text}`);
  }

  const payload = await response.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  store = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + (payload.expires_in * 1000) - (5 * 60 * 1000),
    accountId: extractAccountId(payload.access_token) ?? store.accountId,
  };

  console.log(`[codex] token refreshed, expires at ${new Date(store.expiresAt).toISOString()}`);
  return store;
}
