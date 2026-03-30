import { Request, Response } from "express";

export interface StreamOptions {
  include_usage?: boolean;
}

export interface ToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface Tool {
  type: "function";
  function: ToolFunction;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface Message {
  role: string;
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatBody {
  model: string;
  messages: Message[];
  stream?: boolean;
  stream_options?: StreamOptions;
  n?: number;
  max_tokens?: number;
  tools?: Tool[];
  tool_choice?: string | { type: string; function?: { name: string } };
}

export interface CompletionsBody {
  model: string;
  prompt: string | string[];
  stream?: boolean;
  stream_options?: StreamOptions;
  max_tokens?: number;
}

export interface EmbeddingsBody {
  model: string;
  input: string | string[];
}

export type ChatProvider = (req: Request, res: Response, body: ChatBody) => Promise<void> | void;
export type CompletionsProvider = (req: Request, res: Response, body: CompletionsBody) => Promise<void> | void;
export type EmbeddingsProvider = (req: Request, res: Response, body: EmbeddingsBody) => Promise<void>;
