import mongoose from "mongoose";
import type { AppConfig } from "./env.js";

let connectionPromise: Promise<void> | undefined;
let lastFailureAt: number | undefined;

/** After a failed connection, requests fail fast for this long instead of each waiting ~10 s. */
export const CONNECTION_FAILURE_COOLDOWN_MS = 5_000;

export class DatabaseCooldownError extends Error {
  override name = "DatabaseCooldownError";
}

export function resetDatabaseCooldownForTests(): void {
  lastFailureAt = undefined;
}

export async function connectToDatabase(config: AppConfig): Promise<void> {
  if (isDatabaseConnected()) return;
  if (connectionPromise) return connectionPromise;
  if (lastFailureAt !== undefined && Date.now() - lastFailureAt < CONNECTION_FAILURE_COOLDOWN_MS) {
    throw new DatabaseCooldownError("Database connection is cooling down after a failure.");
  }
  connectionPromise = mongoose.connect(config.mongoUri, {
    dbName: config.mongoDatabase,
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
    autoIndex: false,
  }).then(() => undefined);
  try {
    await connectionPromise;
    lastFailureAt = undefined;
  } catch (error) {
    lastFailureAt = Date.now();
    throw error;
  } finally {
    connectionPromise = undefined;
  }
}

export async function disconnectFromDatabase(): Promise<void> {
  await mongoose.disconnect();
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}