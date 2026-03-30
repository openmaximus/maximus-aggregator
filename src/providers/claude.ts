import Anthropic from "@anthropic-ai/sdk";
import { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ChatBody, CompletionsBody, Message, Tool } from "./types";
import { getClaudeCredentials } from "./claudeCredentials";
import { mapProviderError } from "../lib/errorMapper";

function generateChatId(): string {
  return `chatcmpl-${uuidv4().replace(/-/g, "").slice(0, 29)}`;
}

function generateCmplId(): string {
  return `cmpl-${uuidv4().replace(/-/g, "").slice(0, 29)}`;
}

const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

function extractSystem(messages: Message[]): {
  systemTexts: string[];
  filtered: Message[];
} {
  const systemTexts = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content?.trim() || "")
    .filter(Boolean);
  const filtered = messages.filter((m) => m.role !== "system");
  return { systemTexts, filtered };
}

function buildSystemPrompt(systemTexts: string[]): Anthropic.TextBlockParam[] {
  return [
    {
      type: "text",
      text: CLAUDE_CODE_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
    ...systemTexts.map((text) => ({
      type: "text" as const,
      text,
      cache_control: { type: "ephemeral" as const },
    })),
  ];
}

// Convert OpenAI messages (including tool_calls and tool role) to Anthropic format.
// Consecutive "tool" role messages are grouped into a single user message.
function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content ?? "" });
      i++;
    } else if (msg.role === "assistant") {
      if (msg.tool_calls?.length) {
        const content: Anthropic.ContentBlockParam[] = [];
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(tc.function.arguments); } catch { /* keep empty */ }
          content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
        }
        result.push({ role: "assistant", content });
      } else {
        result.push({ role: "assistant", content: msg.content ?? "" });
      }
      i++;
    } else if (msg.role === "tool") {
      // Group all consecutive tool results into one user message
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      while (i < messages.length && messages[i].role === "tool") {
        const t = messages[i];
        toolResults.push({
          type: "tool_result",
          tool_use_id: t.tool_call_id ?? "",
          content: t.content ?? "",
        });
        i++;
      }
      result.push({ role: "user", content: toolResults });
    } else {
      i++;
    }
  }

  return result;
}

// Convert OpenAI tool definitions to Anthropic format.
function toAnthropicTools(tools: Tool[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    input_schema: (t.function.parameters ?? {
      type: "object",
      properties: {},
    }) as Anthropic.Tool["input_schema"],
  }));
}

// Convert OpenAI tool_choice to Anthropic tool_choice.
// Returns undefined for "none" (caller should omit tools entirely).
function toAnthropicToolChoice(
  choice: ChatBody["tool_choice"]
): Anthropic.ToolChoice | undefined {
  if (!choice || choice === "auto") return { type: "auto" };
  if (choice === "none") return undefined;
  if (choice === "required") return { type: "any" };
  if (typeof choice === "object" && choice.type === "function" && choice.function?.name) {
    return { type: "tool", name: choice.function.name };
  }
  return { type: "auto" };
}

async function makeClient(): Promise<Anthropic> {
  const credentials = await getClaudeCredentials();
  return new Anthropic({
    apiKey: null as unknown as string,
    authToken: credentials.accessToken,
    defaultHeaders: {
      accept: "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
      "user-agent": "claude-cli/2.1.2 (external, cli)",
      "x-app": "cli",
    },
  });
}

export async function handleClaudeChat(
  _req: Request,
  res: Response,
  body: ChatBody
): Promise<void> {
  const { model, messages = [], stream = false, stream_options, max_tokens = 1024, tools, tool_choice } = body;
  const { systemTexts, filtered } = extractSystem(messages);
  const anthropicMessages = toAnthropicMessages(filtered);
  const system = buildSystemPrompt(systemTexts);
  const id = generateChatId();
  const created = Math.floor(Date.now() / 1000);

  // tool_choice "none" means strip tools entirely
  const includeTools = tools?.length && tool_choice !== "none";
  const anthropicTools = includeTools ? toAnthropicTools(tools!) : undefined;
  const anthropicToolChoice = includeTools ? toAnthropicToolChoice(tool_choice) : undefined;

  // Enable adaptive thinking for Sonnet and Opus — transparent to clients.
  const thinkingParam: Anthropic.ThinkingConfigParam | undefined =
    /sonnet|opus/i.test(model) ? { type: "adaptive" } : undefined;

  let client: Anthropic;
  try {
    client = await makeClient();
  } catch (err) {
    const { status, type, code, message } = mapProviderError(err);
    res.status(status).json({ error: { message, type, code } });
    return;
  }

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens,
    messages: anthropicMessages,
    system,
    ...(anthropicTools ? { tools: anthropicTools } : {}),
    ...(anthropicToolChoice ? { tool_choice: anthropicToolChoice } : {}),
    ...(thinkingParam ? { thinking: thinkingParam } : {}),
  };

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Role chunk
    res.write(`data: ${JSON.stringify({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    })}\n\n`);

    try {
      const sdkStream = client.messages.stream({ ...params });

      // Maps Anthropic content block index → { openaiIndex, id, name }
      const toolBlockMap = new Map<number, { openaiIndex: number; id: string; name: string }>();
      let toolCallCounter = 0;

      // Track which content block indices are thinking blocks (to skip their deltas)
      const thinkingBlockIndices = new Set<number>();

      for await (const event of sdkStream) {
        if (event.type === "content_block_start") {
          if (event.content_block.type === "thinking") {
            thinkingBlockIndices.add(event.index);
          } else if (event.content_block.type === "tool_use") {
            const block = event.content_block;
            const openaiIndex = toolCallCounter++;
            toolBlockMap.set(event.index, { openaiIndex, id: block.id, name: block.name });
            res.write(`data: ${JSON.stringify({
              id, object: "chat.completion.chunk", created, model,
              choices: [{ index: 0, delta: {
                tool_calls: [{ index: openaiIndex, id: block.id, type: "function", function: { name: block.name, arguments: "" } }],
              }, finish_reason: null }],
            })}\n\n`);
          }
        } else if (event.type === "content_block_delta") {
          if (thinkingBlockIndices.has(event.index)) {
            // skip thinking deltas — internal reasoning, not surfaced to client
          } else if (event.delta.type === "text_delta") {
            res.write(`data: ${JSON.stringify({
              id, object: "chat.completion.chunk", created, model,
              choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }],
            })}\n\n`);
          } else if (event.delta.type === "input_json_delta") {
            const block = toolBlockMap.get(event.index);
            if (block) {
              res.write(`data: ${JSON.stringify({
                id, object: "chat.completion.chunk", created, model,
                choices: [{ index: 0, delta: {
                  tool_calls: [{ index: block.openaiIndex, function: { arguments: event.delta.partial_json } }],
                }, finish_reason: null }],
              })}\n\n`);
            }
          }
        } else if (event.type === "message_delta" && event.delta.stop_reason) {
          const finishReason = event.delta.stop_reason === "tool_use" ? "tool_calls" : "stop";
          res.write(`data: ${JSON.stringify({
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          })}\n\n`);
        }
      }

      if (stream_options?.include_usage) {
        const final = await sdkStream.finalMessage();
        const usage = {
          prompt_tokens: final.usage.input_tokens,
          completion_tokens: final.usage.output_tokens,
          total_tokens: final.usage.input_tokens + final.usage.output_tokens,
        };
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage })}\n\n`);
      }

      res.write("data: [DONE]\n\n");
      res.end();
    } catch (err) {
      const { type, code, message } = mapProviderError(err);
      res.write(`data: ${JSON.stringify({ error: { message, type, code } })}\n\n`);
      res.end();
    }
    return;
  }

  // Non-streaming
  try {
    const message = await client.messages.create(params);

    // Filter out thinking blocks — they are internal reasoning, not surfaced to client
    const textContent = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as Anthropic.TextBlock).text)
      .join("");

    const toolUseBlocks = message.content.filter(
      (b) => b.type === "tool_use"
    ) as Anthropic.ToolUseBlock[];

    const finishReason = message.stop_reason === "tool_use" ? "tool_calls" : "stop";

    const toolCalls = toolUseBlocks.length
      ? toolUseBlocks.map((tu) => ({
          id: tu.id,
          type: "function" as const,
          function: { name: tu.name, arguments: JSON.stringify(tu.input) },
        }))
      : undefined;

    const usage = {
      prompt_tokens: message.usage.input_tokens,
      completion_tokens: message.usage.output_tokens,
      total_tokens: message.usage.input_tokens + message.usage.output_tokens,
    };

    res.json({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: textContent || null,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      }],
      usage,
    });
  } catch (err) {
    const { status, type, code, message } = mapProviderError(err);
    res.status(status).json({ error: { message, type, code } });
  }
}

export async function handleClaudeCompletions(
  _req: Request,
  res: Response,
  body: CompletionsBody
): Promise<void> {
  const { model, prompt = "", stream = false, stream_options, max_tokens = 1024 } = body;
  const promptText = Array.isArray(prompt) ? prompt.join(" ") : String(prompt);
  const id = generateCmplId();
  const created = Math.floor(Date.now() / 1000);

  let client: Anthropic;
  try {
    client = await makeClient();
  } catch (err) {
    const { status, type, code, message } = mapProviderError(err);
    res.status(status).json({ error: { message, type, code } });
    return;
  }

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens,
    messages: [{ role: "user", content: promptText }],
    system: buildSystemPrompt([]),
  };

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    try {
      const sdkStream = client.messages.stream({ ...params });

      for await (const event of sdkStream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          res.write(`data: ${JSON.stringify({
            id, object: "text_completion", created, model,
            choices: [{ text: event.delta.text, index: 0, logprobs: null, finish_reason: null }],
          })}\n\n`);
        } else if (event.type === "message_delta" && event.delta.stop_reason) {
          res.write(`data: ${JSON.stringify({
            id, object: "text_completion", created, model,
            choices: [{ text: "", index: 0, logprobs: null, finish_reason: "stop" }],
          })}\n\n`);
        }
      }

      if (stream_options?.include_usage) {
        const final = await sdkStream.finalMessage();
        const usage = {
          prompt_tokens: final.usage.input_tokens,
          completion_tokens: final.usage.output_tokens,
          total_tokens: final.usage.input_tokens + final.usage.output_tokens,
        };
        res.write(`data: ${JSON.stringify({ id, object: "text_completion", created, model, choices: [], usage })}\n\n`);
      }

      res.write("data: [DONE]\n\n");
      res.end();
    } catch (err) {
      const { type, code, message } = mapProviderError(err);
      res.write(`data: ${JSON.stringify({ error: { message, type, code } })}\n\n`);
      res.end();
    }
    return;
  }

  // Non-streaming
  try {
    const message = await client.messages.create(params);
    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as Anthropic.TextBlock).text)
      .join("");
    const usage = {
      prompt_tokens: message.usage.input_tokens,
      completion_tokens: message.usage.output_tokens,
      total_tokens: message.usage.input_tokens + message.usage.output_tokens,
    };
    res.json({
      id,
      object: "text_completion",
      created,
      model,
      choices: [{ text: text.trim(), index: 0, logprobs: null, finish_reason: "stop" }],
      usage,
    });
  } catch (err) {
    const { status, type, code, message } = mapProviderError(err);
    res.status(status).json({ error: { message, type, code } });
  }
}
