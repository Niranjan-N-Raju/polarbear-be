import type { RequestHandler } from "express";
import { connectToDatabase } from "../config/database.js";
import { ConfigurationError, loadConfig } from "../config/env.js";

export const vercelDatabase: RequestHandler = async (request, response, next) => {
  if (process.env.VERCEL !== "1") {
    next();
    return;
  }

  let stage = "configuration";
  try {
    const config = loadConfig();
    stage = "connection";
    await connectToDatabase(config);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error("[database] Configuration invalid:", error.message);
    } else {
      console.error(`[database] ${stage} failed.`,
        error instanceof Error ? error.name : "UnknownError");
    }
    response.status(503).json(request.path === "/health"
      ? { status: "unavailable", database: "disconnected" }
      : { message: "Database unavailable. Please try again later." });
    return;
  }
  next();
};
