import { codexModels } from "./codexModels";
import { claudeModels } from "./claudeModels";

export interface ModelObject {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  context_window?: number;
  max_input_tokens?: number;
}

// Add new provider model arrays here as they are introduced.
export const allModels: ModelObject[] = [
  ...codexModels,
  ...claudeModels,
];
