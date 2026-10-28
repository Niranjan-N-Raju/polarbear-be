import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { after, before, it } from "node:test";
import { app } from "../src/app.js";

let server: Server;
let baseUrl: string;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server.close();
  await once(server, "close");
});

it("returns a public greeting without credentials or a database connection", async () => {
  const response = await fetch(`${baseUrl}/api/greet`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(await response.json(), {
    message: "Hello! Welcome to Vajan PB.",
  });
});

it("does not bypass authentication on protected routes", async () => {
  const response = await fetch(`${baseUrl}/api/me`);
  assert.equal(response.status, 401);
});
