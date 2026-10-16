import mongoose from "mongoose";
import type { AppConfig } from "./env.js";

export async function connectToDatabase(config: AppConfig): Promise<void> {
  await mongoose.connect(config.mongoUri, {
    dbName: config.mongoDatabase,
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
    autoIndex: false,
  });
}

export async function disconnectFromDatabase(): Promise<void> {
  await mongoose.disconnect();
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}