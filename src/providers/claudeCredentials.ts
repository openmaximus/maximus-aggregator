import { refreshClaudeToken, isTokenExpired } from "../lib/claudeOAuth";

interface ClaudeCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

// In-memory store — seeded from env vars at startup.
let store: ClaudeCredentials = {
  accessToken: process.env.CLAUDE_ACCESS_TOKEN ?? "",
  refreshToken: process.env.CLAUDE_REFRESH_TOKEN ?? "",
  expiresAt: Number(process.env.CLAUDE_EXPIRES_AT ?? 0),
};

export async function getClaudeCredentials(): Promise<ClaudeCredentials> {
  if (!isTokenExpired(store.expiresAt)) return store;

  const refreshed = await refreshClaudeToken(store.refreshToken);
  store = { ...refreshed };
  console.log(`[claude] token refreshed, expires at ${new Date(store.expiresAt).toISOString()}`);
  return store;
}
