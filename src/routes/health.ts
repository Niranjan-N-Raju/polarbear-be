import { Router } from "express";
import { isDatabaseConnected } from "../config/database.js";

export const healthRouter = Router();

healthRouter.get("/health", (_request, response) => {
  const connected = isDatabaseConnected();
  response.status(connected ? 200 : 503).json({
    status: connected ? "ok" : "unavailable",
    database: connected ? "connected" : "disconnected",
  });
});