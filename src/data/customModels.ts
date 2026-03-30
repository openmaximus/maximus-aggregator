import fs from "fs";
import path from "path";
import { ModelObject } from "./modelRegistry";

export interface CustomModelEntry {
  id: string;
  base: string;
  instructions: string;
  acceptsTools: boolean;
}

// Populated once at startup by loadCustomModels().
const customModelMap = new Map<string, CustomModelEntry>();

export function getCustomModel(id: string): CustomModelEntry | undefined {
  return customModelMap.get(id);
}

// Parse YAML frontmatter (--- key: value --- body).
function parseFrontmatter(
  content: string
): { data: Record<string, string>; body: string } | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;

  const header = content.slice(4, end).trim();
  const body = content.slice(end + 4).trim();

  const data: Record<string, string> = {};
  for (const line of header.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    data[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }

  return { data, body };
}

// Loads all .md files from <cwd>/.models/, registers valid entries,
// and returns the ModelObject array to be pushed into allModels.
export function loadCustomModels(knownModels: ModelObject[]): ModelObject[] {
  const modelsDir = path.join(process.cwd(), ".models");

  if (!fs.existsSync(modelsDir)) {
    console.log("[customModels] .models directory not found, skipping");
    return [];
  }

  let files: string[];
  try {
    files = fs.readdirSync(modelsDir).filter((f) => f.endsWith(".md"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[customModels] failed to read .models directory: ${msg}`);
    return [];
  }

  const loaded: ModelObject[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(modelsDir, file), "utf-8");
      const parsed = parseFrontmatter(content);

      if (!parsed) {
        console.warn(`[customModels] ${file}: missing or invalid frontmatter, skipping`);
        continue;
      }

      const { name, base } = parsed.data;

      if (!name) {
        console.warn(`[customModels] ${file}: missing 'name' in frontmatter, skipping`);
        continue;
      }

      if (!base) {
        console.warn(`[customModels] ${file}: missing 'base' in frontmatter, skipping`);
        continue;
      }

      const baseModel = knownModels.find((m) => m.id === base);
      if (!baseModel) {
        console.warn(`[customModels] ${file}: base model '${base}' not in registry, skipping`);
        continue;
      }

      if (!parsed.body) {
        console.warn(`[customModels] ${file}: instructions body is empty, skipping`);
        continue;
      }

      const id = `maximus/${name}`;

      const acceptsTools = parsed.data.accepts_tools === "true";

      customModelMap.set(id, { id, base, instructions: parsed.body, acceptsTools });

      loaded.push({
        id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "maximus",
        context_window: baseModel.context_window,
        max_input_tokens: baseModel.max_input_tokens,
      });

      console.log(`[customModels] loaded '${id}' (base: ${base})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[customModels] ${file}: failed to load: ${msg}, skipping`);
    }
  }

  return loaded;
}
