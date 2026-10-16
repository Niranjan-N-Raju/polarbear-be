import dotenv from "dotenv";

export interface AppConfig {
  port: number;
  mongoUri: string;
  mongoDatabase: string;
  jwtSecret: string;
}

export function loadConfig(): AppConfig {
  dotenv.config({ quiet: true });

  const mongoUri = process.env.MONGODB_URI;
  const mongoDatabase = process.env.MONGODB_DB;
  const jwtSecret = process.env.JWT_SECRET;
  const port = Number(process.env.PORT ?? "4000");

  if (!mongoUri || !mongoDatabase) {
    throw new Error("MONGODB_URI and MONGODB_DB are required.");
  }
  if (!jwtSecret) {
    throw new Error("JWT_SECRET is required.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  return { port, mongoUri, mongoDatabase, jwtSecret };
}