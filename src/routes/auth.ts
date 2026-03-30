import { Router, Request, Response } from "express";
import { getAuthorizationUrl, exchangeCodeForTokens, parseOAuthInput } from "../lib/codexOAuth";
import { getAuthorizationUrl as getClaudeAuthorizationUrl, exchangeCodeForTokens as exchangeClaudeCodeForTokens } from "../lib/claudeOAuth";

const router = Router();

// GET /v1/auth/codex
// Returns the PKCE authorization URL and the verifier the client must hold
// until it calls /exchange. No server-side state is stored.
router.get("/codex", (_req: Request, res: Response) => {
  try {
    const { url, verifier, state } = getAuthorizationUrl();
    res.json({ url, verifier, state });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate authorization URL";
    res.status(500).json({ error: { message, type: "server_error", code: "auth_error" } });
  }
});

// POST /v1/auth/codex/exchange
// Accepts { code, verifier } or { url, verifier } (full callback URL).
// Returns raw credentials — caller decides what to do with them.
router.post("/codex/exchange", async (req: Request, res: Response) => {
  const { code, url, verifier } = req.body ?? {};

  if (!verifier) {
    res.status(400).json({
      error: { message: "Missing required parameter: 'verifier'", type: "invalid_request_error", param: "verifier", code: null },
    });
    return;
  }

  if (!code && !url) {
    res.status(400).json({
      error: { message: "Provide either 'code' or 'url' (full callback URL)", type: "invalid_request_error", param: "code", code: null },
    });
    return;
  }

  const { code: parsedCode } = parseOAuthInput(url ?? code);

  if (!parsedCode) {
    res.status(400).json({
      error: { message: "Could not extract authorization code from provided input", type: "invalid_request_error", param: "code", code: null },
    });
    return;
  }

  try {
    const tokens = await exchangeCodeForTokens(parsedCode, verifier);
    res.json(tokens);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Token exchange failed";
    res.status(502).json({ error: { message, type: "upstream_error", code: "exchange_error" } });
  }
});

// GET /v1/auth/claude
// Returns the PKCE authorization URL and verifier. No server-side state stored.
router.get("/claude", (_req: Request, res: Response) => {
  try {
    const { url, verifier } = getClaudeAuthorizationUrl();
    res.json({ url, verifier });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate authorization URL";
    res.status(500).json({ error: { message, type: "server_error", code: "auth_error" } });
  }
});

// POST /v1/auth/claude/exchange
// Accepts { code, verifier }. Code may include "#state" suffix — stripped automatically.
// Returns raw credentials — caller decides what to do with them.
router.post("/claude/exchange", async (req: Request, res: Response) => {
  const { code, verifier } = req.body ?? {};

  if (!verifier) {
    res.status(400).json({
      error: { message: "Missing required parameter: 'verifier'", type: "invalid_request_error", param: "verifier", code: null },
    });
    return;
  }

  if (!code) {
    res.status(400).json({
      error: { message: "Missing required parameter: 'code'", type: "invalid_request_error", param: "code", code: null },
    });
    return;
  }

  // Strip "#state" suffix Anthropic appends to the code.
  const parsedCode = String(code).split("#")[0].trim();

  if (!parsedCode) {
    res.status(400).json({
      error: { message: "Could not extract authorization code from provided input", type: "invalid_request_error", param: "code", code: null },
    });
    return;
  }

  try {
    const tokens = await exchangeClaudeCodeForTokens(parsedCode, verifier);
    res.json(tokens);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Token exchange failed";
    res.status(502).json({ error: { message, type: "upstream_error", code: "exchange_error" } });
  }
});

export default router;
