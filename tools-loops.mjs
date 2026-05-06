/**
 * Tool Execution Loops
 *
 * Responsibilities:
 * - Manage conversation loops with tool calling
 * - Execute tools and feed results back to providers
 * - Handle tool guard checks
 *
 * NOT Responsibilities:
 * - Provider API communication (providers/)
 * - Payload construction (services/chat-payloads.js)
 * - Direct SDK calls (providers/)
 */

import { ToolGuard } from './tools-guard.js';
import { normalizeToolFailure, parseOllamaToolCall, normalizeToolSuccess } from './utils.js';
import { normalizeToolName } from './names.js';
import { OLLAMA_TOOL_DEFINITIONS } from './tools-executer.js';
import {
  buildAnthropicPayload,
  buildOpenAICodexPayload,
  buildOllamaPayload,
  buildOllamaMessages
} from '../services/chat-payloads.js';
import {
  streamAnthropicResponse,
  streamOllamaResponse,
  streamCodexResponse
} from '../services/chat-stream.js';
import { emitError, emitSessionPatch } from '../events/protocol.js';
import {
  extractAnthropicText,
  extractAnthropicToolUses,
  extractCodexText
} from '../services/chat-responses.js';

function createChatCancelledError(reason = 'Chat cancelled by client') {
  const error = new Error(reason);
  error.name = 'ChatCancelledError';
  return error;
}

function throwIfCancelled(abortSignal) {
  if (abortSignal?.aborted) {
    throw abortSignal.reason || createChatCancelledError();
  }
}

export async function runAnthropicLoop({
  ws,
  client,
  baseMessages,
  systemPrompt,
  memoryText,
  model,
  maxTokens,
  isOAuth,
  abortSignal,
  runToolCall,
  memoryStore,
  onStats
}) {
  let messages = baseMessages;
  let finalText = '';
  const toolGuard = new ToolGuard();

  while (true) {
    throwIfCancelled(abortSignal);
    const params = buildAnthropicPayload(
      messages,
      systemPrompt,
      memoryText,
      isOAuth,
      model,
      maxTokens
    );

    if (onStats) {
      onStats({ model: params.model, limits: { maxTokens: params.max_tokens } });
    }

    const { finalMessage, rateLimits } = await streamAnthropicResponse(
      client,
      ws,
      params,
      abortSignal
    );

    if (onStats) {
      const updates = {};
      if (rateLimits) updates.rateLimits = rateLimits;
      if (finalMessage) {
        updates.usage = finalMessage.usage || null;
        updates.model = finalMessage.model || model;
      }
      onStats(updates);
    }

    if (!finalMessage) {
      return finalText;
    }

    finalText = extractAnthropicText(finalMessage);
    const toolUses = extractAnthropicToolUses(finalMessage);

    if (!toolUses.length) {
      return finalText;
    }

    const toolResults = [];
    for (const toolUse of toolUses) {
      throwIfCancelled(abortSignal);
      const toolCallId = toolUse.id;
      // Preserve original provider tool name for matching; normalize only for execution
      const providerToolName = toolUse.name;
      const execToolName = normalizeToolName(toolUse.name);

      const guard = toolGuard.check(execToolName);
      if (!guard.allowed) {
        const failure = normalizeToolFailure(guard.error, { tool: providerToolName, input: toolUse.input });
        emitError(ws, `${failure.error} ${failure.recommendation}`);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCallId,
          content: JSON.stringify(failure)
        });
        emitSessionPatch(ws, {
          op: 'toolStart',
          toolCallId,
          toolName: providerToolName,
          reason: toolUse.input?.reason || null
        });
        emitSessionPatch(ws, {
          op: 'toolEnd',
          toolCallId,
          success: false,
          result: failure
        });
        continue;
      }

      const reason = toolUse.input?.reason || null;

      emitSessionPatch(ws, {
        op: 'toolStart',
        toolCallId,
        toolName: providerToolName,
        reason
      });

      let result;
      try {
        result = await runToolCall({ name: execToolName, input: toolUse.input });
      } catch (err) {
        result = normalizeToolFailure(
          'Tool execution threw an error.',
          { tool: providerToolName, message: err instanceof Error ? err.message : String(err) }
        );
      }

      let normalized = result;
      let success = true;
      if (result?.error || result?.success === false || (typeof result?.exit_code === 'number' && result.exit_code !== 0)) {
        const reasonText = result?.error || result?.stderr || 'Tool execution failed.';
        normalized = normalizeToolFailure(reasonText, result);
        success = false;
      } else if (result?.success !== true) {
        normalized = normalizeToolSuccess(result);
      }

      emitSessionPatch(ws, {
        op: 'toolEnd',
        toolCallId,
        success,
        result: normalized
      });

      if (memoryStore) {
        memoryStore.ingestText({
          sessionId: ws.sessionId,
          provider: 'anthropic',
          role: 'tool',
          text: JSON.stringify({ name: providerToolName, reason, success, toolCallId }),
          source: 'chat'
        });
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(normalized)
      });
    }

    messages = [
      ...messages,
      { role: 'assistant', content: finalMessage.content },
      { role: 'user', content: toolResults }
    ];
  }
}

export async function runOpenAICodexLoop({
  ws,
  credentials,
  baseMessages,
  systemPrompt,
  memoryText,
  model,
  abortSignal,
  runToolCall,
  memoryStore,
  onStats
}) {
  let messages = baseMessages;
  const toolGuard = new ToolGuard();
  let finalText = '';

  while (true) {
    throwIfCancelled(abortSignal);
    const params = buildOpenAICodexPayload(
      messages,
      systemPrompt,
      memoryText,
      credentials,
      model
    );

    if (onStats) {
      onStats({ model: params.model });
    }

    const result = await streamCodexResponse(ws, { ...params, abortSignal });
    const { content, toolCalls, usage, limits } = result;

    if (onStats && usage) {
      onStats({ usage });
    }
    if (onStats && limits) {
      onStats({ limits });
    }

    const textParts = extractCodexText(content);
    finalText = textParts;

    if (!toolCalls || toolCalls.length === 0) {
      return finalText;
    }

    const toolResults = [];

    messages.push({ role: 'assistant', content: content });

    for (const call of toolCalls) {
      throwIfCancelled(abortSignal);
      const toolCallId = call.id;
      // Preserve original provider tool name for matching; normalize only for execution
      const providerToolName = call.name;
      const execToolName = normalizeToolName(call.name);

      const guard = toolGuard.check(execToolName);
      if (!guard.allowed) {
        const failure = normalizeToolFailure(guard.error, { tool: providerToolName, input: call.input });
        emitError(ws, `${failure.error} ${failure.recommendation}`);
        emitSessionPatch(ws, {
          op: 'toolStart',
          toolCallId,
          toolName: providerToolName,
          reason: call.input?.reason || null
        });
        emitSessionPatch(ws, {
          op: 'toolEnd',
          toolCallId,
          success: false,
          result: failure
        });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCallId,
          content: JSON.stringify(failure)
        });
        continue;
      }

      const reason = call.input?.reason || null;

      emitSessionPatch(ws, {
        op: 'toolStart',
        toolCallId,
        toolName: providerToolName,
        reason
      });

      let execResult;
      try {
        execResult = await runToolCall({ name: execToolName, input: call.input });
      } catch (err) {
        execResult = normalizeToolFailure(
          'Tool execution threw an error.',
          { tool: providerToolName, message: err instanceof Error ? err.message : String(err) }
        );
      }

      let normalized = execResult;
      let success = true;
      if (execResult?.error || execResult?.success === false || (typeof execResult?.exit_code === 'number' && execResult.exit_code !== 0)) {
        const reasonText = execResult?.error || execResult?.stderr || 'Tool execution failed.';
        normalized = normalizeToolFailure(reasonText, execResult);
        success = false;
      } else if (execResult?.success !== true) {
        normalized = normalizeToolSuccess(execResult);
      }

      emitSessionPatch(ws, {
        op: 'toolEnd',
        toolCallId,
        success,
        result: normalized
      });

      if (memoryStore) {
        memoryStore.ingestText({
          sessionId: ws.sessionId,
          provider: 'openai-codex',
          role: 'tool',
          text: JSON.stringify({ name: providerToolName, reason, success, toolCallId }),
          source: 'chat'
        });
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolCallId,
        content: JSON.stringify(normalized)
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }
}

export async function runOllamaLoop({
  ws,
  client,
  baseMessages,
  systemPrompt,
  memoryText,
  model,
  abortSignal,
  runToolCall,
  memoryStore,
  onStats
}) {
  let messages = buildOllamaMessages(baseMessages, memoryText, systemPrompt);
  let finalText = '';
  const toolGuard = new ToolGuard();

  while (true) {
    throwIfCancelled(abortSignal);
    const params = buildOllamaPayload(
      model,
      messages,
      OLLAMA_TOOL_DEFINITIONS
    );

    const { toolCalls, assistantText, usage } = await streamOllamaResponse(
      client,
      ws,
      params,
      abortSignal
    );

    if (onStats && usage) {
      onStats({ usage });
    }

    if (!toolCalls.length) {
      finalText = assistantText;
      return finalText;
    }

    const normalizedToolCalls = toolCalls.map(parseOllamaToolCall);
    const toolMessages = [];
    const makeToolCallId = (name) => `${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    for (const call of normalizedToolCalls) {
      throwIfCancelled(abortSignal);
      const toolCallId = call.id || makeToolCallId(call.name);
      // Use normalized name for execution, original name for provider-facing operations
      const execToolName = call.name;
      const providerToolName = call.originalName || call.name;

      const guard = toolGuard.check(execToolName);
      if (!guard.allowed) {
        const failure = normalizeToolFailure(guard.error, { tool: providerToolName, input: call.input });
        emitError(ws, `${failure.error} ${failure.recommendation}`);
        emitSessionPatch(ws, {
          op: 'toolStart',
          toolCallId,
          toolName: providerToolName,
          reason: call.input?.reason || null
        });
        emitSessionPatch(ws, {
          op: 'toolEnd',
          toolCallId,
          success: false,
          result: failure
        });
        toolMessages.push({
          role: 'tool',
          name: providerToolName,
          content: JSON.stringify(failure)
        });
        continue;
      }

      const reason = call.input?.reason || null;

      emitSessionPatch(ws, {
        op: 'toolStart',
        toolCallId,
        toolName: providerToolName,
        reason
      });

      let result;
      try {
        result = await runToolCall({ name: execToolName, input: call.input });
      } catch (err) {
        result = normalizeToolFailure(
          'Tool execution threw an error.',
          { tool: providerToolName, message: err instanceof Error ? err.message : String(err) }
        );
      }

      let normalized = result;
      let success = true;
      if (result?.error || result?.success === false || (typeof result?.exit_code === 'number' && result.exit_code !== 0)) {
        const reasonText = result?.error || result?.stderr || 'Tool execution failed.';
        normalized = normalizeToolFailure(reasonText, result);
        success = false;
      } else if (result?.success !== true) {
        normalized = normalizeToolSuccess(result);
      }

      emitSessionPatch(ws, {
        op: 'toolEnd',
        toolCallId,
        success,
        result: normalized
      });

      if (memoryStore) {
        memoryStore.ingestText({
          sessionId: ws.sessionId,
          provider: 'ollama',
          role: 'tool',
          text: JSON.stringify({ name: providerToolName, reason, success, toolCallId }),
          source: 'chat'
        });
      }

      toolMessages.push({
        role: 'tool',
        name: providerToolName,
        content: JSON.stringify(normalized)
      });
    }

    messages = [
      ...messages,
      { role: 'assistant', content: '', tool_calls: toolCalls },
      ...toolMessages
    ];
  }
}

export function extractAnthropicToolUses(message) {
  if (!message || !Array.isArray(message.content)) return [];
  return message.content.filter((block) => block.type === 'tool_use');
}
