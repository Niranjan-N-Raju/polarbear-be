import dotenv from "dotenv";

export interface AppConfig {
  port: number;
  mongoUri: string;
  mongoDatabase: string;
  jwtSecret: string;
}

export class ConfigurationError extends Error {
  override name = "ConfigurationError";
}

export function loadConfig(): AppConfig {
  dotenv.config({ quiet: true });

  const mongoUri = process.env.MONGODB_URI;
  const mongoDatabase = process.env.MONGODB_DB;
  const jwtSecret = process.env.JWT_SECRET;
  const port = Number(process.env.PORT ?? "4000");

  if (!mongoUri || !mongoDatabase) {
    throw new ConfigurationError("MONGODB_URI and MONGODB_DB are required.");
  }
  if (!jwtSecret) {
    throw new ConfigurationError("JWT_SECRET is required.");
  }
  if (jwtSecret.length < 32) {
    throw new ConfigurationError("JWT_SECRET must be at least 32 characters.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError("PORT must be an integer between 1 and 65535.");
  }
  if (process.env.NODE_ENV === "production") {
    if (!process.env.WEB_ORIGINS?.trim()) {
      throw new ConfigurationError("WEB_ORIGINS must list the allowed browser origins in production.");
    }
    if (!/^[0-9a-fA-F]{64}$/.test(process.env.FIELD_ENCRYPTION_KEY ?? "")) {
      throw new ConfigurationError("FIELD_ENCRYPTION_KEY (64 hex characters) is required in production.");
    }
  }

  return { port, mongoUri, mongoDatabase, jwtSecret };
}