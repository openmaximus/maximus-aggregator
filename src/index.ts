import "dotenv/config";

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[unhandledRejection]", reason);
});

process.on("uncaughtException", (err: Error) => {
  console.error("[uncaughtException]", err.message, err.stack);
});
import express, { Request, Response, NextFunction } from "express";
import modelsRouter from "./routes/models";
import chatRouter from "./routes/chat";
import completionsRouter from "./routes/completions";
import embeddingsRouter from "./routes/embeddings";
import authRouter from "./routes/auth";
import { getPipeline } from "./providers/xenova";
import { loadCustomModels } from "./data/customModels";
import { allModels } from "./data/modelRegistry";

const app = express();
const PORT = process.env.PORT ?? 3000;
const HOST = process.env.HOST ?? "localhost";

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Request logger
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Routes
app.use("/v1/models", modelsRouter);
app.use("/v1/chat/completions", chatRouter);
app.use("/v1/completions", completionsRouter);
app.use("/v1/embeddings", embeddingsRouter);
app.use("/v1/auth", authRouter);

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: {
      message: "Not found",
      type: "invalid_request_error",
      code: "not_found",
    },
  });
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err.stack);
  res.status(500).json({
    error: {
      message: "Internal server error",
      type: "server_error",
      code: "internal_error",
    },
  });
});

async function start() {
  const customLoaded = loadCustomModels(allModels);
  if (customLoaded.length) {
    allModels.push(...customLoaded);
  }

  console.log(`[xenova] warming up embeddings pipeline...`);
  await getPipeline();

  app.listen(Number(PORT), HOST, () => {
    console.log(`OpenAI-compatible API running on http://${HOST}:${PORT}`);
    console.log(`  GET  /v1/models`);
    console.log(`  GET  /v1/models/:model`);
    console.log(`  POST /v1/chat/completions  (streaming supported)`);
    console.log(`  POST /v1/completions       (streaming supported)`);
    console.log(`  POST /v1/embeddings`);
    console.log(`  GET  /health`);
  });
}

start();
