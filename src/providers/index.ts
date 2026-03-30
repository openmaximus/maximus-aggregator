import { ChatProvider, CompletionsProvider } from "./types";
import { handleCodexChat, handleCodexCompletions } from "./codex";
import { handleClaudeChat, handleClaudeCompletions } from "./claude";

// Map owned_by values to their provider handlers.
// Add new providers here as they are introduced.
export const chatProviders: Record<string, ChatProvider> = {
  codex: handleCodexChat,
  claude: handleClaudeChat,
};

export const completionsProviders: Record<string, CompletionsProvider> = {
  codex: handleCodexCompletions,
  claude: handleClaudeCompletions,
};
