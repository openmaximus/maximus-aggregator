import { Request, Response, NextFunction } from "express";
import { getCustomModel } from "../data/customModels";
import { Message } from "../providers/types";

// Extract content from <TOOLS>...</TOOLS> or {{TOOLS}}...{{/TOOLS}} blocks.
function extractToolsBlock(text: string): string | null {
  const xml = text.match(/<TOOLS>([\s\S]*?)<\/TOOLS>/i);
  if (xml) return xml[1].trim();

  const hbs = text.match(/\{\{TOOLS\}\}([\s\S]*?)\{\{\/TOOLS\}\}/i);
  if (hbs) return hbs[1].trim();

  return null;
}

export function createCustomModelMiddleware(type: "chat" | "completions") {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const body = req.body;
    const modelId: string | undefined = body?.model;

    if (!modelId?.startsWith("maximus/")) {
      return next();
    }

    const custom = getCustomModel(modelId);
    if (!custom) {
      return next();
    }

    // Swap to base model so provider dispatch works unchanged.
    body.model = custom.base;

    if (type === "chat") {
      const incoming: Message[] = Array.isArray(body.messages) ? body.messages : [];

      // Collect any TOOLS blocks from incoming system messages.
      const toolsBlocks: string[] = [];
      const nonSystem = incoming.filter((m) => {
        if (m.role === "system") {
          if (custom.acceptsTools) {
            const block = extractToolsBlock(m.content ?? "");
            if (block) toolsBlocks.push(block);
          }
          return false;
        }
        return true;
      });

      // Build final system content: custom instructions + extracted tools (if any).
      let systemContent = custom.instructions;
      if (custom.acceptsTools && toolsBlocks.length > 0) {
        systemContent += "\n\n" + toolsBlocks.join("\n\n");
      }

      body.messages = [{ role: "system", content: systemContent }, ...nonSystem];

      // Block tools array when accepts_tools is false.
      if (!custom.acceptsTools) {
        body.tools = [];
      }
    } else {
      // Completions: no TOOLS block extraction — chat only.
      const raw = Array.isArray(body.prompt)
        ? (body.prompt as string[]).join(" ")
        : String(body.prompt ?? "");

      body.prompt = custom.instructions + "\n\n" + raw;

      if (!custom.acceptsTools) {
        body.tools = [];
      }
    }

    next();
  };
}
