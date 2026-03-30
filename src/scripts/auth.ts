import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { getAuthorizationUrl, exchangeCodeForTokens, parseOAuthInput } from "../lib/codexOAuth";

const ENV_PATH = path.resolve(process.cwd(), ".env");

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    else if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Ignore — user will open manually
  }
}

function patchEnvFile(updates: Record<string, string>): void {
  let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content = content.endsWith("\n") ? content + `${key}=${value}\n` : content + `\n${key}=${value}\n`;
    }
  }

  fs.writeFileSync(ENV_PATH, content, "utf8");
}

async function main(): Promise<void> {
  console.log("\n=== Codex OAuth Authentication ===\n");

  const { url, verifier, state } = getAuthorizationUrl();

  console.log("Authorization URL:\n");
  console.log(`  ${url}\n`);

  const autoOpen = process.env.MAXIMUS_TUI_OAUTH_AUTO_OPEN !== "false";
  if (autoOpen) {
    console.log("Opening browser...");
    openBrowser(url);
  } else {
    console.log("Open the URL above in your browser to authenticate.");
  }

  console.log(`\nAfter authorizing, paste the full callback URL or just the code below.`);
  const input = await prompt("Callback URL or code: ");

  if (!input) {
    console.error("No input provided. Aborting.");
    process.exit(1);
  }

  const { code, state: returnedState } = parseOAuthInput(input, state);

  if (!code) {
    console.error("Could not extract authorization code from input. Aborting.");
    process.exit(1);
  }

  if (returnedState && returnedState !== state) {
    console.warn("Warning: state mismatch. The response may not match this auth request.");
  }

  console.log("\nExchanging code for tokens...");

  let tokens: Awaited<ReturnType<typeof exchangeCodeForTokens>>;
  try {
    tokens = await exchangeCodeForTokens(code, verifier);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`Token exchange failed: ${message}`);
    process.exit(1);
  }

  const updates: Record<string, string> = {
    CODEX_ACCESS_TOKEN: tokens.accessToken,
    CODEX_REFRESH_TOKEN: tokens.refreshToken,
    CODEX_EXPIRES_AT: String(tokens.expiresAt),
    ...(tokens.accountId ? { CODEX_ACCOUNT_ID: tokens.accountId } : {}),
  };

  patchEnvFile(updates);

  const expiryDate = new Date(tokens.expiresAt).toISOString();
  console.log(`\n✓ Credentials written to .env`);
  console.log(`  Account ID : ${tokens.accountId ?? "(not found)"}`);
  console.log(`  Expires at : ${expiryDate}`);
  console.log(`\nRestart the server to apply the new credentials.\n`);
}

main();
