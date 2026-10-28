import type { RequestHandler } from "express";
import { connectToDatabase } from "../config/database.js";
import { loadConfig } from "../config/env.js";

export const vercelDatabase: RequestHandler = async (request, response, next) => {
  if (process.env.VERCEL !== "1") {
    next();
    return;
  }

  try {
    await connectToDatabase(loadConfig());
  } catch (error) {
    console.error("[database] Initialization failed. Check server configuration and MongoDB connectivity.",
      error instanceof Error ? error.name : "UnknownError");
    response.status(503).json(request.path === "/health"
      ? { status: "unavailable", database: "disconnected" }
      : { message: "Database unavailable. Please try again later." });
    return;
  }
  next();
};
