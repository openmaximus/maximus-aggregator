# maximus-aggregator — Agent Integration Guide

OpenAI-compatible REST API aggregator running locally. Routes requests to Anthropic Claude or OpenAI Codex based on the model requested. Exposes a local embeddings endpoint and supports custom agent personas via `.models/` files.

---

## Base URL and Authentication

```
Base URL: http://localhost:3000
Auth:     Bearer <any-string>   ← the API key is not validated; any value works
```

All requests must include the header:

```
Authorization: Bearer fake:apiKey
```

---

## Available Models

### Claude (Anthropic) — `owned_by: claude`

| Model ID | Context Window | Max Input Tokens |
|---|---|---|
| `claude-opus-4-6` | 200,000 | 146,000 |
| `claude-sonnet-4-6` | 200,000 | 146,000 |
| `claude-sonnet-4-5-20250929` | 200,000 | 146,000 |
| `claude-haiku-4-5-20251001` | 200,000 | 146,000 |

- Adaptive thinking is automatically enabled for Sonnet and Opus models. Thinking blocks are stripped before the response is returned — clients receive only the final answer.
- System messages are extracted and forwarded as Anthropic system prompts with prompt caching enabled.

### Codex (OpenAI) — `owned_by: codex`

| Model ID | Context Window | Max Input Tokens |
|---|---|---|
| `gpt-5.1-codex` | 400,000 | 272,000 |
| `gpt-5.1-codex-max` | 400,000 | 272,000 |
| `gpt-5.2-codex` | 400,000 | 272,000 |
| `gpt-5.3-codex` | 400,000 | 272,000 |

- Tool call IDs use the `fc_` prefix. When feeding tool results back, echo the `id` as-is into `tool_call_id` — no transformation needed.

### Embeddings — always local (`owned_by: xenova`)

| Model ID (ignored) | Dimensions |
|---|---|
| any value | 384 |

The embeddings endpoint always uses `@xenova/transformers` locally with `Xenova/all-MiniLM-L6-v2`. The `model` parameter is accepted but ignored.

### Custom Agent Models — `owned_by: claude` or `owned_by: codex`

Custom models are loaded from `.models/*.md` at startup. They follow the pattern `maximus/<name>` and prepend a system instruction to every request.

| Model ID | Base Model | Description |
|---|---|---|
| `maximus/code-reviewer` | `claude-sonnet-4-6` | Expert code reviewer — correctness, security, performance |
| `maximus/coding-orchestrator` | `gpt-5.2-codex` | Workflow orchestrator with task planning and subagent strategy |

To discover all registered models at runtime:

```http
GET /v1/models
```

---

## Endpoints

### Health Check

```http
GET /health
```

```json
{ "status": "ok" }
```

---

### List Models

```http
GET /v1/models
Authorization: Bearer fake:apiKey
```

Returns all registered models (Claude, Codex, custom).

---

### Get Single Model

```http
GET /v1/models/:modelId
Authorization: Bearer fake:apiKey
```

Returns full spec including `context_window` and `max_input_tokens`.

---

### Chat Completions

```http
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer fake:apiKey
```

**Minimal request:**

```json
{
  "model": "claude-sonnet-4-6",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "What is quicksand?" }
  ],
  "max_tokens": 512
}
```

**Response:**

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "claude-sonnet-4-6",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "..." },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 47,
    "completion_tokens": 204,
    "total_tokens": 251
  }
}
```

**Streaming:**

```json
{
  "model": "claude-sonnet-4-6",
  "messages": [{ "role": "user", "content": "Hello" }],
  "stream": true,
  "max_tokens": 256
}
```

Emits `text/event-stream` SSE chunks (`chat.completion.chunk`). Add `"stream_options": { "include_usage": true }` to receive a final usage chunk before `[DONE]`.

---

### Tool Calls

```json
{
  "model": "claude-sonnet-4-6",
  "messages": [{ "role": "user", "content": "What is the weather in Lisbon?" }],
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get current weather for a location.",
      "parameters": {
        "type": "object",
        "properties": {
          "location": { "type": "string" }
        },
        "required": ["location"]
      }
    }
  }],
  "tool_choice": "auto",
  "max_tokens": 256
}
```

When the model calls a tool, `finish_reason` is `"tool_calls"` and the response includes:

```json
"tool_calls": [{
  "id": "toolu_...",
  "type": "function",
  "function": { "name": "get_weather", "arguments": "{\"location\": \"Lisbon\"}" }
}]
```

Feed the result back as a second turn:

```json
{
  "model": "claude-sonnet-4-6",
  "messages": [
    { "role": "user", "content": "What is the weather in Lisbon?" },
    { "role": "assistant", "content": null, "tool_calls": [{ "id": "toolu_...", "type": "function", "function": { "name": "get_weather", "arguments": "{\"location\": \"Lisbon\"}" } }] },
    { "role": "tool", "tool_call_id": "toolu_...", "content": "22°C and sunny" }
  ],
  "tools": [{ ... }],
  "max_tokens": 256
}
```

**`tool_choice` values:** `"auto"` · `"none"` · `"required"` · `{ "type": "function", "function": { "name": "..." } }`

---

### Text Completions

```http
POST /v1/completions
Content-Type: application/json
Authorization: Bearer fake:apiKey
```

```json
{
  "model": "gpt-5.1-codex",
  "prompt": "Explain recursion in simple terms.",
  "max_tokens": 256
}
```

Array prompts are joined with a space. Supports `stream` and `stream_options.include_usage`. **No tool calls** on this endpoint.

---

### Embeddings

```http
POST /v1/embeddings
Content-Type: application/json
Authorization: Bearer fake:apiKey
```

```json
{
  "model": "text-embedding-ada-002",
  "input": "The food was delicious."
}
```

Batch input:

```json
{
  "model": "text-embedding-ada-002",
  "input": ["Hello world", "How are you?"]
}
```

Returns 384-dimensional vectors. `model` parameter is ignored.

---

## Recommended Packages

The API is fully OpenAI-compatible. Use the standard OpenAI SDK pointing at the local base URL:

### Node.js / TypeScript

```bash
npm install openai
```

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: "fake:apiKey",
});

const response = await client.chat.completions.create({
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "Hello" }],
  max_tokens: 256,
});
```

### Python

```bash
pip install openai
```

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="fake:apiKey",
)

response = client.chat.completions.create(
    model="claude-sonnet-4-6",
    messages=[{"role": "user", "content": "Hello"}],
    max_tokens=256,
)
```

### Anthropic SDK / Claude Code SDK

If using the Anthropic SDK directly, it will not work — point at this aggregator using the OpenAI SDK instead, which is fully compatible.

---

## Error Responses

All errors follow this shape:

```json
{
  "error": {
    "message": "...",
    "type": "authentication_error",
    "code": "token_expired"
  }
}
```

| HTTP | `type` | `code` | Cause | Fix |
|---|---|---|---|---|
| 401 | `authentication_error` | `token_expired` | OAuth refresh token expired or revoked | Run `npm run auth:claude` or `npm run auth:codex` |
| 401 | `authentication_error` | `invalid_token` | Provider rejected the access token | Re-authenticate |
| 403 | `permission_error` | `access_denied` | Account lacks access to the model | Verify account permissions |
| 429 | `rate_limit_error` | `rate_limited` | Provider rate limit hit | Back off and retry |
| 502 | `upstream_error` | `provider_error` | Any other provider failure | Check provider status or retry |

**Streaming errors** are emitted as an SSE data event before the stream closes:

```
data: {"error": {"message": "...", "type": "...", "code": "..."}}
```

---

## Custom Models

Drop a `.md` file in `.models/` and restart the server:

```markdown
---
name: my-agent
base: claude-sonnet-4-6
---
You are a specialized agent that does X.
```

The model becomes available as `maximus/my-agent`. The `base` must match an existing model ID. Instructions are appended to the system prompt on every request — transparent to the caller.

---

## Common Patterns for Agents

### Prefer streaming for long responses

```typescript
const stream = await client.chat.completions.create({
  model: "claude-sonnet-4-6",
  messages,
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 4096,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

### Always handle 401 as a re-auth signal

```typescript
try {
  const response = await client.chat.completions.create({ ... });
} catch (err) {
  if (err.status === 401) {
    // Tokens are expired — signal operator to re-authenticate
    throw new Error("Re-authentication required: run npm run auth:claude");
  }
  throw err;
}
```

### Choose the right model for the task

| Task | Recommended model |
|---|---|
| General reasoning, long context | `claude-sonnet-4-6` |
| Highest quality, complex tasks | `claude-opus-4-6` |
| Fast, lightweight responses | `claude-haiku-4-5-20251001` |
| Code generation, agentic coding | `gpt-5.1-codex` or `gpt-5.2-codex` |
| Code review | `maximus/code-reviewer` |
| Workflow orchestration | `maximus/coding-orchestrator` |
| Semantic search / RAG | embeddings endpoint (any model ID) |

### No auth on the aggregator side

The aggregator does **not** validate the `Authorization` header from callers — any bearer token value is accepted. Authentication happens between the aggregator and the upstream providers (Claude, Codex) using OAuth tokens stored in `.env`. Agents do not need real API keys to call this aggregator.
