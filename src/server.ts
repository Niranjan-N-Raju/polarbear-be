import { app } from "./app.js";
import { loadConfig } from "./config/env.js";
import { connectToDatabase, disconnectFromDatabase } from "./config/database.js";
import { configureTrustProxy } from "./middleware/securityHeaders.js";

async function main(): Promise<void> {
  const config = loadConfig();
  configureTrustProxy(app);
  await connectToDatabase(config);
  console.log("MongoDB connected.");

  const server = app.listen(config.port, "0.0.0.0", () => {
    console.log(`API listening on http://localhost:${config.port}`);
  });

  server.on("error", () => {
    console.error("API failed to listen. Check whether PORT is already in use.");
    void disconnectFromDatabase().finally(() => {
      process.exitCode = 1;
    });
  });

  let stopping = false;
  function shutdown(): void {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
    server.close(() => {
      void disconnectFromDatabase()
        .catch(() => {
          process.exitCode = 1;
        })
        .finally(() => {
          clearTimeout(deadline);
        });
    });
  }

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void main().catch(async () => {
  console.error("Startup failed. Check MONGODB_URI, MONGODB_DB, JWT_SECRET, PORT, and MongoDB connectivity.");
  await disconnectFromDatabase();
  process.exitCode = 1;
});