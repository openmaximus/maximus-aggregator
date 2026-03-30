import { Request, Response } from "express";
import { EmbeddingsBody } from "./types";

// Lazily loaded — model is downloaded from HuggingFace on first request and cached.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipelineInstance: any | null = null;

const MODEL = process.env.XENOVA_EMBEDDINGS_MODEL ?? "Xenova/all-MiniLM-L6-v2";

export async function getPipeline() {
  if (pipelineInstance) return pipelineInstance;
  const { pipeline } = await import("@xenova/transformers");
  pipelineInstance = await pipeline("feature-extraction", MODEL);
  console.log(`[xenova] embeddings pipeline loaded: ${MODEL}`);
  return pipelineInstance;
}

export async function handleXenovaEmbeddings(req: Request, res: Response, body: EmbeddingsBody): Promise<void> {
  const { input } = body;
  const inputs: string[] = Array.isArray(input) ? input : [String(input)];

  let extractor: Awaited<ReturnType<typeof getPipeline>>;
  try {
    extractor = await getPipeline();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load embeddings pipeline";
    res.status(500).json({ error: { message, type: "server_error", code: "pipeline_load_error" } });
    return;
  }

  try {
    const data = await Promise.all(
      inputs.map(async (text, index) => {
        const output = await extractor(text, { pooling: "mean", normalize: true });
        return {
          object: "embedding",
          embedding: Array.from(output.data as Float32Array),
          index,
        };
      })
    );

    const totalTokens = inputs.reduce((acc, t) => acc + Math.ceil(t.length / 4), 0);

    res.json({
      object: "list",
      data,
      model: MODEL,
      usage: { prompt_tokens: totalTokens, total_tokens: totalTokens },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Embedding generation failed";
    res.status(500).json({ error: { message, type: "server_error", code: "embedding_error" } });
  }
}
