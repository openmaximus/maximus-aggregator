import { Router, Request, Response } from "express";
import { allModels } from "../data/modelRegistry";

const router = Router();

// GET /v1/models
router.get("/", (_req: Request, res: Response) => {
  res.json({
    object: "list",
    data: allModels.map(({ id, object, created, owned_by }) => ({ id, object, created, owned_by })),
  });
});

// GET /v1/models/:model
router.get("/:model", (req: Request, res: Response) => {
  const model = allModels.find((m) => m.id === req.params.model);
  if (!model) {
    res.status(404).json({
      error: {
        message: `The model '${req.params.model}' does not exist`,
        type: "invalid_request_error",
        param: "model",
        code: "model_not_found",
      },
    });
    return;
  }
  res.json(model);
});

export default router;
