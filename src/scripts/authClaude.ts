import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { getAuthorizationUrl, exchangeCodeForTokens } from "../lib/claudeOAuth";

const ENV_PATH = path.resolve(process.cwd(), ".env");

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
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
  console.log("\n=== Claude Code OAuth Authentication ===\n");

  const { url, verifier } = getAuthorizationUrl();

  console.log("Authorization URL:\n");
  console.log(`  ${url}\n`);
  try {
    if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    else if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    console.log("Opening browser...");
  } catch {
    console.log("Could not open browser automatically. Open the URL above manually.");
  }
  console.log("After authorizing, Anthropic will redirect to console.anthropic.com");
  console.log("and display your authorization code there.\n");

  const input = await prompt("Paste the authorization code: ");

  if (!input) {
    console.error("No code provided. Aborting.");
    process.exit(1);
  }

  // Anthropic may return the code as "<code>#<state>" — strip the state suffix.
  const code = input.split("#")[0].trim();

  console.log("\nExchanging code for tokens...");

  let tokens: Awaited<ReturnType<typeof exchangeCodeForTokens>>;
  try {
    tokens = await exchangeCodeForTokens(code, verifier);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`Token exchange failed: ${message}`);
    process.exit(1);
  }

  patchEnvFile({
    CLAUDE_ACCESS_TOKEN: tokens.accessToken,
    CLAUDE_REFRESH_TOKEN: tokens.refreshToken,
    CLAUDE_EXPIRES_AT: String(tokens.expiresAt),
  });

  const expiryDate = new Date(tokens.expiresAt).toISOString();
  console.log(`\n✓ Credentials written to .env`);
  console.log(`  Expires at : ${expiryDate}`);
  console.log(`\nRestart the server to apply the new credentials.\n`);
}

main();
