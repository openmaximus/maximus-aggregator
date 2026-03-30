import { Router, Request, Response } from "express";
import { allModels } from "../data/modelRegistry";
import { completionsProviders } from "../providers";
import { createCustomModelMiddleware } from "../middleware/customModel";

const router = Router();

router.use(createCustomModelMiddleware("completions"));

// POST /v1/completions
router.post("/", (req: Request, res: Response) => {
  const body = req.body;
  const modelId: string = body.model;

  if (!modelId) {
    res.status(400).json({
      error: { message: "Missing required parameter: 'model'", type: "invalid_request_error", param: "model", code: null },
    });
    return;
  }

  if (!body.prompt) {
    res.status(400).json({
      error: { message: "Missing required parameter: 'prompt'", type: "invalid_request_error", param: "prompt", code: null },
    });
    return;
  }

  const modelEntry = allModels.find((m) => m.id === modelId);
  if (!modelEntry) {
    res.status(404).json({
      error: { message: `The model '${modelId}' does not exist`, type: "invalid_request_error", param: "model", code: "model_not_found" },
    });
    return;
  }

  const provider = completionsProviders[modelEntry.owned_by];
  if (!provider) {
    res.status(400).json({
      error: { message: `No provider available for model '${modelId}' (owned_by: '${modelEntry.owned_by}')`, type: "invalid_request_error", param: "model", code: "provider_not_found" },
    });
    return;
  }

  // Log early disconnect (client gone before response finished)
  req.on("close", () => {
    if (!res.writableEnded) {
      console.warn(`[completions] [${modelId}] client disconnected before response completed`);
    }
  });

  // Catch write errors (e.g. EPIPE on streaming responses)
  res.on("error", (err: Error) => {
    console.error(`[completions] [${modelId}] response write error: ${err.message}`);
  });

  // Wrap in Promise so both sync throws and async rejections are caught
  Promise.resolve()
    .then(() => provider(req, res, body))
    .catch((err: Error) => {
      console.error(`[completions] [${modelId}] unhandled provider error: ${err.message}`, err.stack);
      if (!res.headersSent) {
        res.status(500).json({ error: { message: "Internal server error", type: "server_error", code: "internal_error" } });
      } else if (!res.writableEnded) {
        res.end();
      }
    });
});

export default router;
