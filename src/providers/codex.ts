import { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ChatBody, CompletionsBody, Message, Tool } from "./types";
import { getCodexCredentials } from "./codexCredentials";
import { mapProviderError } from "../lib/errorMapper";

const FALLBACK_INSTRUCTIONS = "You are a helpful assistant.";

function generateChatId(): string {
  return `chatcmpl-${uuidv4().replace(/-/g, "").slice(0, 29)}`;
}

function generateCmplId(): string {
  return `cmpl-${uuidv4().replace(/-/g, "").slice(0, 29)}`;
}

// Codex uses fc_ prefixed IDs; normalize call_ → fc_ for round-trips.
function normalizeCodexToolId(id: string): string {
  if (!id) return id;
  if (id.startsWith("fc_")) return id;
  if (id.startsWith("call_")) return "fc_" + id.slice(5);
  return "fc_" + id;
}

function extractInstructions(messages: Message[]): {
  instructions: string;
  input: Message[];
} {
  const systemMsg = messages.find((m) => m.role === "system");
  const instructions = systemMsg?.content?.trim() || FALLBACK_INSTRUCTIONS;
  const input = messages.filter((m) => m.role !== "system");
  return { instructions, input };
}

function toCodexInput(messages: Message[]): unknown[] {
  const output: unknown[] = [];
  for (const message of messages) {
    if (message.role === "user" && typeof message.content === "string" && message.content.trim()) {
      output.push({
        role: "user",
        content: [{ type: "input_text", text: message.content }],
      });
    } else if (message.role === "assistant") {
      // Push text content first (if any), then function_call entries
      if (typeof message.content === "string" && message.content.trim()) {
        output.push({
          type: "message",
          role: "assistant",
          status: "completed",
          id: `msg_${uuidv4().replace(/-/g, "").slice(0, 20)}`,
          content: [{ type: "output_text", text: message.content }],
        });
      }
      if (message.tool_calls?.length) {
        for (const tc of message.tool_calls) {
          const normalizedId = normalizeCodexToolId(tc.id);
          output.push({
            type: "function_call",
            id: normalizedId,
            call_id: normalizedId,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      }
    } else if (message.role === "tool") {
      output.push({
        type: "function_call_output",
        call_id: normalizeCodexToolId(message.tool_call_id ?? ""),
        output: message.content ?? "",
      });
    }
  }
  return output;
}

// Convert OpenAI tool definitions to Codex format (flat, not nested under "function").
function convertToolsToCodex(tools: Tool[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    name: t.function.name,
    description: t.function.description ?? "",
    parameters: t.function.parameters ?? { type: "object", properties: {} },
    strict: false,
  }));
}

async function* parseSSE(response: Response | globalThis.Response): AsyncGenerator<Record<string, unknown>> {
  const body = (response as globalThis.Response).body;
  if (!body) return;

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") continue;
        try { yield JSON.parse(data); } catch { /* skip malformed */ }
      }
      idx = buffer.indexOf("\n\n");
    }
  }
}

function extractUsage(event: Record<string, unknown>): { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null {
  const u = (event.response as Record<string, unknown>)?.usage as Record<string, number> | undefined;
  if (!u) return null;
  return {
    prompt_tokens: u.input_tokens ?? 0,
    completion_tokens: u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
  };
}

async function callCodexAPI(
  model: string,
  instructions: string,
  input: unknown[],
  tools?: unknown[]
): Promise<globalThis.Response> {
  const credentials = await getCodexCredentials();
  const chatUrl = process.env.CODEX_CHAT_URL;
  if (!chatUrl) throw new Error("CODEX_CHAT_URL is not set");

  const response = await fetch(chatUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "chatgpt-account-id": credentials.accountId,
      "OpenAI-Beta": "responses=experimental",
      originator: "pi",
      "User-Agent": "maximus-tui",
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      store: false,
      stream: true,
      instructions,
      input,
      ...(tools?.length ? { tools, tool_choice: "auto", parallel_tool_calls: true } : {}),
      text: { verbosity: "medium" },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const error = new Error(`Codex API error ${response.status}: ${body || "request failed"}`);
    (error as NodeJS.ErrnoException).code = String(response.status);
    throw error;
  }

  return response;
}

export async function handleCodexCompletions(req: Request, res: Response, body: CompletionsBody): Promise<void> {
  const { model, prompt = "", stream = false, stream_options } = body;
  const promptText = Array.isArray(prompt) ? prompt.join(" ") : String(prompt);
  const id = generateCmplId();
  const created = Math.floor(Date.now() / 1000);

  const input = [{ role: "user", content: [{ type: "input_text", text: promptText }] }];

  let codexResponse: globalThis.Response;
  try {
    codexResponse = await callCodexAPI(model, FALLBACK_INSTRUCTIONS, input);
  } catch (err) {
    const { status, type, code, message } = mapProviderError(err);
    res.status(status).json({ error: { message, type, code } });
    return;
  }

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    try {
      for await (const event of parseSSE(codexResponse as unknown as Response)) {
        if (event.type === "response.output_text.delta") {
          res.write(`data: ${JSON.stringify({
            id, object: "text_completion", created, model,
            choices: [{ text: event.delta ?? "", index: 0, logprobs: null, finish_reason: null }],
          })}\n\n`);
        } else if (event.type === "response.completed") {
          res.write(`data: ${JSON.stringify({
            id, object: "text_completion", created, model,
            choices: [{ text: "", index: 0, logprobs: null, finish_reason: "stop" }],
          })}\n\n`);
          if (stream_options?.include_usage) {
            const usage = extractUsage(event);
            if (usage) {
              res.write(`data: ${JSON.stringify({ id, object: "text_completion", created, model, choices: [], usage })}\n\n`);
            }
          }
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        } else if (event.type === "error") {
          const msg = (event.message as string) || (event.code as string) || "stream error";
          const { type, code, message } = mapProviderError(new Error(msg));
          res.write(`data: ${JSON.stringify({ error: { message, type, code } })}\n\n`);
          res.end();
          return;
        }
      }
    } catch (err) {
      const { type, code, message } = mapProviderError(err);
      res.write(`data: ${JSON.stringify({ error: { message, type, code } })}\n\n`);
      res.end();
    }
    return;
  }

  // Non-streaming: accumulate full text
  let fullText = "";
  let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;

  try {
    for await (const event of parseSSE(codexResponse as unknown as Response)) {
      if (event.type === "response.output_text.delta") {
        fullText += (event.delta as string) ?? "";
      } else if (event.type === "response.completed") {
        usage = extractUsage(event);
      } else if (event.type === "error") {
        throw new Error((event.message as string) || "stream error");
      }
    }
  } catch (err) {
    const { status, type, code, message } = mapProviderError(err);
    res.status(status).json({ error: { message, type, code } });
    return;
  }

  res.json({
    id,
    object: "text_completion",
    created,
    model,
    choices: [{ text: fullText.trim(), index: 0, logprobs: null, finish_reason: "stop" }],
    usage,
  });
}

export async function handleCodexChat(req: Request, res: Response, body: ChatBody): Promise<void> {
  const { model, messages = [], stream = false, stream_options, tools, tool_choice } = body;
  const { instructions, input } = extractInstructions(messages);
  const codexInput = toCodexInput(input);
  const id = generateChatId();
  const created = Math.floor(Date.now() / 1000);

  const includeTools = tools?.length && tool_choice !== "none";
  const codexTools = includeTools ? convertToolsToCodex(tools!) : undefined;

  let codexResponse: globalThis.Response;
  try {
    codexResponse = await callCodexAPI(model, instructions, codexInput, codexTools);
  } catch (err) {
    const { status, type, code, message } = mapProviderError(err);
    res.status(status).json({ error: { message, type, code } });
    return;
  }

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

    // Track streaming tool calls: Codex streams args via call_id-less delta events,
    // currentToolCallId tracks which tool is receiving deltas.
    const toolBlockMap = new Map<string, { openaiIndex: number; name: string }>();
    let currentToolCallId: string | null = null;
    let toolCallCounter = 0;
    let hasToolCalls = false;

    try {
      for await (const event of parseSSE(codexResponse as unknown as Response)) {
        if (event.type === "response.output_text.delta") {
          res.write(`data: ${JSON.stringify({
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: { content: event.delta ?? "" }, finish_reason: null }],
          })}\n\n`);
        } else if (event.type === "response.output_item.added") {
          const item = event.item as { type: string; call_id: string; name: string };
          if (item.type === "function_call") {
            hasToolCalls = true;
            currentToolCallId = item.call_id;
            const openaiIndex = toolCallCounter++;
            toolBlockMap.set(item.call_id, { openaiIndex, name: item.name });
            res.write(`data: ${JSON.stringify({
              id, object: "chat.completion.chunk", created, model,
              choices: [{ index: 0, delta: {
                tool_calls: [{ index: openaiIndex, id: item.call_id, type: "function", function: { name: item.name, arguments: "" } }],
              }, finish_reason: null }],
            })}\n\n`);
          }
        } else if (event.type === "response.function_call_arguments.delta") {
          if (currentToolCallId) {
            const tool = toolBlockMap.get(currentToolCallId);
            if (tool) {
              res.write(`data: ${JSON.stringify({
                id, object: "chat.completion.chunk", created, model,
                choices: [{ index: 0, delta: {
                  tool_calls: [{ index: tool.openaiIndex, function: { arguments: event.delta ?? "" } }],
                }, finish_reason: null }],
              })}\n\n`);
            }
          }
        } else if (event.type === "response.output_item.done") {
          const item = event.item as { type: string };
          if (item.type === "function_call") {
            currentToolCallId = null;
          }
        } else if (event.type === "response.completed") {
          const finishReason = hasToolCalls ? "tool_calls" : "stop";
          res.write(`data: ${JSON.stringify({
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          })}\n\n`);
          if (stream_options?.include_usage) {
            const usage = extractUsage(event);
            if (usage) {
              res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage })}\n\n`);
            }
          }
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        } else if (event.type === "error") {
          const msg = (event.message as string) || (event.code as string) || "stream error";
          const { type, code, message } = mapProviderError(new Error(msg));
          res.write(`data: ${JSON.stringify({ error: { message, type, code } })}\n\n`);
          res.end();
          return;
        }
      }
    } catch (err) {
      const { type, code, message } = mapProviderError(err);
      res.write(`data: ${JSON.stringify({ error: { message, type, code } })}\n\n`);
      res.end();
    }
    return;
  }

  // Non-streaming: accumulate text and tool calls
  let fullText = "";
  const toolCallsMap = new Map<string, { id: string; name: string; argsBuf: string }>();
  let currentToolCallId: string | null = null;
  let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;

  try {
    for await (const event of parseSSE(codexResponse as unknown as Response)) {
      if (event.type === "response.output_text.delta") {
        fullText += (event.delta as string) ?? "";
      } else if (event.type === "response.output_item.added") {
        const item = event.item as { type: string; call_id: string; name: string };
        if (item.type === "function_call") {
          currentToolCallId = item.call_id;
          toolCallsMap.set(item.call_id, { id: item.call_id, name: item.name, argsBuf: "" });
        }
      } else if (event.type === "response.function_call_arguments.delta") {
        if (currentToolCallId) {
          const tool = toolCallsMap.get(currentToolCallId);
          if (tool) tool.argsBuf += (event.delta as string) ?? "";
        }
      } else if (event.type === "response.output_item.done") {
        const item = event.item as { type: string; call_id: string; arguments: string };
        if (item.type === "function_call") {
          const tool = toolCallsMap.get(item.call_id);
          if (tool) tool.argsBuf = item.arguments ?? tool.argsBuf;
          currentToolCallId = null;
        }
      } else if (event.type === "response.completed") {
        usage = extractUsage(event);
      } else if (event.type === "error") {
        throw new Error((event.message as string) || "stream error");
      }
    }
  } catch (err) {
    const { status, type, code, message } = mapProviderError(err);
    res.status(status).json({ error: { message, type, code } });
    return;
  }

  if (toolCallsMap.size > 0) {
    const toolCalls = Array.from(toolCallsMap.values()).map((tool) => ({
      id: tool.id,
      type: "function" as const,
      function: { name: tool.name, arguments: tool.argsBuf },
    }));
    res.json({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: null, tool_calls: toolCalls },
        finish_reason: "tool_calls",
      }],
      usage,
    });
  } else {
    res.json({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: fullText.trim() }, finish_reason: "stop" }],
      usage,
    });
  }
}
