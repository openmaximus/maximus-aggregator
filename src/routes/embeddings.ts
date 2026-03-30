import { Router, Request, Response } from "express";
import { handleXenovaEmbeddings } from "../providers/xenova";

const router = Router();

// POST /v1/embeddings
// Always routed to @xenova/transformers regardless of model parameter.
router.post("/", (req: Request, res: Response) => {
  const body = req.body;

  if (!body.input) {
    res.status(400).json({
      error: { message: "Missing required parameter: 'input'", type: "invalid_request_error", param: "input", code: null },
    });
    return;
  }

  handleXenovaEmbeddings(req, res, body);
});

export default router;
