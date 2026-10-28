import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { after, afterEach, before, beforeEach, it, mock } from "node:test";
import mongoose from "mongoose";
import { app } from "../src/app.js";
import { connectToDatabase } from "../src/config/database.js";
import type { AppConfig } from "../src/config/env.js";

const keys = ["VERCEL", "NODE_ENV", "MONGODB_URI", "MONGODB_DB", "JWT_SECRET"] as const;
const savedEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const readyStateDescriptor = Object.getOwnPropertyDescriptor(mongoose.connection, "readyState");
const config: AppConfig = {
  port: 4000,
  mongoUri: "mongodb://127.0.0.1:27017",
  mongoDatabase: "test",
  jwtSecret: "vercel-database-tests-only-not-a-production-secret",
};
let state = 0;
let server: Server;
let baseUrl: string;

before(async () => {
  Object.defineProperty(mongoose.connection, "readyState", { configurable: true, get: () => state });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}/api`;
});

beforeEach(() => {
  state = 0;
  process.env.VERCEL = "1";
  process.env.NODE_ENV = "test";
  process.env.MONGODB_URI = config.mongoUri;
  process.env.MONGODB_DB = config.mongoDatabase;
  process.env.JWT_SECRET = config.jwtSecret;
});

afterEach(() => mock.restoreAll());
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (readyStateDescriptor) Object.defineProperty(mongoose.connection, "readyState", readyStateDescriptor);
  else Reflect.deleteProperty(mongoose.connection, "readyState");
  for (const key of keys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

it("shares concurrent connection attempts and reuses an established connection", async () => {
  let finish!: (value: typeof mongoose) => void;
  const connect = mock.method(mongoose, "connect", () => new Promise<typeof mongoose>(resolve => { finish = resolve; }));
  const first = connectToDatabase(config);
  const second = connectToDatabase(config);
  assert.equal(connect.mock.callCount(), 1);
  state = 1;
  finish(mongoose);
  await Promise.all([first, second]);
  await connectToDatabase(config);
  assert.equal(connect.mock.callCount(), 1);
});

it("connects before health checks and authentication routing on Vercel", async () => {
  const connect = mock.method(mongoose, "connect", async () => { state = 1; return mongoose; });
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", database: "connected" });
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(login.status, 400);
  assert.equal(connect.mock.callCount(), 1);
});

it("reports failures without leaking details and retries on the next request", async () => {
  const log = mock.method(console, "error", () => {});
  const connect = mock.method(mongoose, "connect", async () => { throw new Error("private connection details"); });
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 503);
  assert.deepEqual(await health.json(), { status: "unavailable", database: "disconnected" });
  const login = await fetch(`${baseUrl}/auth/login`, { method: "POST" });
  assert.equal(login.status, 503);
  assert.deepEqual(await login.json(), { message: "Database unavailable. Please try again later." });
  assert.equal(connect.mock.callCount(), 2);
  assert.ok(!JSON.stringify(log.mock.calls).includes("private connection details"));
  connect.mock.mockImplementation(async () => { state = 1; return mongoose; });
  assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
});

it("keeps the public greeting independent of MongoDB", async () => {
  const connect = mock.method(mongoose, "connect", async () => { throw new Error("must not connect"); });
  assert.equal((await fetch(`${baseUrl}/greet`)).status, 200);
  assert.equal(connect.mock.callCount(), 0);
});

it("preserves local server initialization outside Vercel", async () => {
  delete process.env.VERCEL;
  const connect = mock.method(mongoose, "connect", async () => { throw new Error("must not connect"); });
  assert.equal((await fetch(`${baseUrl}/health`)).status, 503);
  assert.equal(connect.mock.callCount(), 0);
});
