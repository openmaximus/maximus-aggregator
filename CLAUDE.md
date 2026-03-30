# node-maximus-agregator

## Keeping this file up to date

This file is the primary context source for Claude Code in this project. Update it whenever the structure changes: new files, removed files, new endpoints, new providers, new environment variables, or any architectural decision worth remembering. Keep each entry to one line. Run `npx tsc --noEmit` to confirm the project compiles before documenting changes as final.

---

OpenAI-compatible REST API aggregator written in TypeScript + Express. Routes requests to the correct provider based on model registry.

## Structure

- `src/index.ts` — entry point, Express app setup, route wiring, dotenv loading, xenova pipeline warm-up at startup
- `src/data/modelRegistry.ts` — `ModelObject` type and `allModels` array combining all provider model lists
- `src/data/codexModels.ts` — hardcoded OpenAI Codex models (`owned_by: "codex"`)
- `src/data/customModels.ts` — loads `.models/*.md` at startup; parses YAML frontmatter (`name`, `base`); registers entries in `customModelMap`; exposes `loadCustomModels()` and `getCustomModel()`
- `src/middleware/customModel.ts` — `createCustomModelMiddleware(type)` intercepts `maximus/*` model requests; swaps model to base; appends instructions to system prompt (chat) or prompt string (completions)
- `src/data/claudeModels.ts` — hardcoded Anthropic Claude models (`owned_by: "claude"`)
- `src/lib/codexOAuth.ts` — Codex PKCE OAuth helpers: `getAuthorizationUrl`, `exchangeCodeForTokens`, `parseOAuthInput`
- `src/lib/claudeOAuth.ts` — Claude PKCE OAuth helpers: `getAuthorizationUrl`, `exchangeCodeForTokens`, `refreshClaudeToken`, `isTokenExpired`
- `src/providers/types.ts` — shared interfaces: `Message`, `Tool`, `ToolCall`, `ChatBody` (with `tools`/`tool_choice`), `CompletionsBody`, `EmbeddingsBody`, provider function types
- `src/providers/index.ts` — registries mapping `owned_by` to handler: `chatProviders`, `completionsProviders`
- `src/providers/codex.ts` — real Codex proxy for chat and completions; handles tool calls via `response.output_item.added`/`response.function_call_arguments.delta` SSE events; converts OpenAI tools to Codex flat format; normalizes IDs to `fc_` prefix
- `src/providers/codexCredentials.ts` — in-memory Codex OAuth credentials store; auto-refreshes token when expired using `CODEX_REFRESH_TOKEN`
- `src/providers/claude.ts` — Claude provider for chat and completions via `@anthropic-ai/sdk`; translates OpenAI tools/tool_choice/tool-role messages to Anthropic format; converts tool_use blocks back to OpenAI tool_calls; supports streaming tool_call deltas + non-streaming + `stream_options.include_usage`
- `src/providers/claudeCredentials.ts` — in-memory Claude OAuth credentials store; auto-refreshes token when expired using `CLAUDE_REFRESH_TOKEN`
- `src/providers/xenova.ts` — local embeddings via `@xenova/transformers`; singleton pipeline pre-loaded at startup
- `src/routes/models.ts` — models endpoints, reads from `allModels`
- `src/routes/chat.ts` — dispatches to provider via model registry `owned_by` lookup
- `src/routes/completions.ts` — dispatches to provider via model registry `owned_by` lookup
- `src/routes/embeddings.ts` — always routes to xenova regardless of model parameter
- `src/routes/auth.ts` — OAuth PKCE endpoints for Codex and Claude Code
- `src/scripts/auth.ts` — CLI script for Codex OAuth flow; patches `.env` with new credentials
- `src/scripts/authClaude.ts` — CLI script for Claude OAuth flow; patches `.env` with new credentials

## Endpoints

- `GET  /v1/models` — list all models (id, object, created, owned_by)
- `GET  /v1/models/:model` — single model with full spec (adds `context_window`, `max_input_tokens`)
- `POST /v1/chat/completions` — proxies to provider by `owned_by`; supports `stream: true`, `stream_options.include_usage`, `tools`, and `tool_choice`
- `POST /v1/completions` — proxies to provider by `owned_by`; supports `stream: true` and `stream_options.include_usage` (no tool calls)
- `POST /v1/embeddings` — local inference via `@xenova/transformers`; ignores model parameter
- `GET  /v1/auth/codex` — generate Codex PKCE authorization URL; returns `{ url, verifier, state }`
- `POST /v1/auth/codex/exchange` — exchange Codex code for tokens; accepts `{ code|url, verifier }`
- `GET  /v1/auth/claude` — generate Claude PKCE authorization URL; returns `{ url, verifier }`
- `POST /v1/auth/claude/exchange` — exchange Claude code for tokens; accepts `{ code, verifier }`, strips `#state` suffix automatically
- `GET  /health` — health check

## npm scripts

- `npm run dev` — start with hot reload via ts-node-dev
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run compiled build
- `npm run auth:codex` — interactive CLI to complete Codex OAuth flow and write credentials to `.env`
- `npm run auth:claude` — interactive CLI to complete Claude OAuth flow and write credentials to `.env`

## Custom models (.models/)

Drop a `.md` file in `.models/` with YAML frontmatter and a plain-text instruction body:

```markdown
---
name: my-agent
base: claude-sonnet-4-6
---
You are a specialized agent that...
```

- `name` becomes the model ID: `maximus/<name>`
- `base` must match an existing model ID in the registry; file is skipped with a warning otherwise
- Instructions are appended to the system prompt (chat) or prompt string (completions) at request time
- Models are loaded once at startup; restart the server to pick up new or changed files

## Adding a new provider

1. Add model list at `src/data/<provider>Models.ts` with `owned_by: "<provider>"`
2. Spread it into `allModels` in `src/data/modelRegistry.ts`
3. Create handler at `src/providers/<provider>.ts` implementing `ChatProvider` and/or `CompletionsProvider`
4. Register in `src/providers/index.ts` under `chatProviders` and/or `completionsProviders`

## Environment variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `HOST` | Bind address (default: localhost) |
| `XENOVA_EMBEDDINGS_MODEL` | HuggingFace model for embeddings (default: `Xenova/all-MiniLM-L6-v2`) |
| `CODEX_CHAT_URL` | Codex responses endpoint |
| `CODEX_AUTHORIZE_URL` | Codex OAuth authorization URL |
| `CODEX_TOKEN_URL` | Codex OAuth token + refresh URL |
| `CODEX_REDIRECT_URI` | Codex OAuth redirect URI |
| `CODEX_ACCESS_TOKEN` | Codex access token (seeded from env, refreshed in memory) |
| `CODEX_REFRESH_TOKEN` | Codex refresh token |
| `CODEX_EXPIRES_AT` | Codex access token expiry in Unix ms |
| `CODEX_ACCOUNT_ID` | ChatGPT account ID (from JWT claim) |
| `CLAUDE_AUTHORIZE_URL` | Claude OAuth authorization URL |
| `CLAUDE_TOKEN_URL` | Claude OAuth token + refresh URL |
| `CLAUDE_REDIRECT_URI` | Claude OAuth redirect URI |
| `CLAUDE_ACCESS_TOKEN` | Claude access token (seeded from env, refreshed in memory) |
| `CLAUDE_REFRESH_TOKEN` | Claude refresh token |
| `CLAUDE_EXPIRES_AT` | Claude access token expiry in Unix ms |
