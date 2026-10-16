import express from "express";
import type { ErrorRequestHandler } from "express";
import { authRouter } from "./routes/auth.js";
import { healthRouter } from "./routes/health.js";

export const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use("/api/auth", authRouter);
app.use("/api", healthRouter);

app.use((_request, response) => {
  response.status(404).json({ message: "Route not found." });
});

const handleError: ErrorRequestHandler = (_error, _request, response, _next) => {
  response.status(500).json({ message: "Internal server error." });
};

app.use(handleError);