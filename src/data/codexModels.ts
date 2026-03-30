import { ModelObject } from "./modelRegistry";

export const codexModels: ModelObject[] = [
  { id: "gpt-5.1-codex",     object: "model", created: 1747000000, owned_by: "codex", context_window: 400_000, max_input_tokens: 272_000 },
  { id: "gpt-5.1-codex-max", object: "model", created: 1747000001, owned_by: "codex", context_window: 400_000, max_input_tokens: 272_000 },
  { id: "gpt-5.2-codex",     object: "model", created: 1748000000, owned_by: "codex", context_window: 400_000, max_input_tokens: 272_000 },
  { id: "gpt-5.3-codex",     object: "model", created: 1749000000, owned_by: "codex", context_window: 400_000, max_input_tokens: 272_000 },
];
