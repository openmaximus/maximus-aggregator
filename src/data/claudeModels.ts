import { ModelObject } from "./modelRegistry";

export const claudeModels: ModelObject[] = [
  { id: "claude-opus-4-6",                    object: "model", created: 1749000000, owned_by: "claude", context_window: 200_000, max_input_tokens: 146_000 },
  { id: "claude-sonnet-4-6",                  object: "model", created: 1749000001, owned_by: "claude", context_window: 200_000, max_input_tokens: 146_000 },
  { id: "claude-sonnet-4-5-20250929",           object: "model", created: 1748500000, owned_by: "claude", context_window: 200_000, max_input_tokens: 146_000 },
  { id: "claude-haiku-4-5-20251001",            object: "model", created: 1748000000, owned_by: "claude", context_window: 200_000, max_input_tokens: 146_000 },
];
