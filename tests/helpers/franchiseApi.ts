import assert from "node:assert/strict";
import type { Server } from "node:http";
import { once } from "node:events";
import { after, afterEach, before, beforeEach, mock } from "node:test";
import mongoose from "mongoose";
import { app } from "../../src/app.js";
import { Franchise } from "../../src/models/Franchise.js";
import { User } from "../../src/models/User.js";
import { signSessionToken } from "../../src/utils/token.js";
import { resetRateLimitsForTests } from "../../src/utils/rateLimit.js";
import { EmployeeCounter } from "../../src/utils/employeeCode.js";

export const userId = new mongoose.Types.ObjectId();
export const storeId = new mongoose.Types.ObjectId();
export const otherStoreId = new mongoose.Types.ObjectId();

export function queryResult(value: unknown) {
  return {
    select() {
      return this;
    },
    sort() {
      return this;
    },
    populate() {
      return this;
    },
    limit() {
      return this;
    },
    skip() {
      return this;
    },
    lean: async () => value,
    then(
      resolve: (input: unknown) => unknown,
      reject?: (error: unknown) => unknown
    ) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
}

export function setupFranchiseApi(
  options: {
    franchise?: () => Record<string, unknown>;
    storeIds?: mongoose.Types.ObjectId[];
    initialStoreId?: string | null;
  } = {}
) {
  const state = { url: "", token: "" };
  const assignedStoreIds = options.storeIds ?? [storeId];
  const configuredStoreIds = [...assignedStoreIds];
  let initialToken = "";
  const initialStoreId =
    options.initialStoreId === null
      ? undefined
      : options.initialStoreId ??
        (assignedStoreIds.length === 1
          ? String(assignedStoreIds[0])
          : undefined);
  let server: Server;
  const previousSecret = process.env.JWT_SECRET;

  before(async () => {
    process.env.JWT_SECRET = "unit-test-only-not-a-production-secret";
    initialToken = await signSessionToken({
      id: String(userId),
      name: "Test",
      email: "test@example.test",
      role: "franchise_admin",
      ...(initialStoreId ? { storeId: initialStoreId } : {}),
    });
    state.token = initialToken;
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    state.url = `http://127.0.0.1:${address.port}/api`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  beforeEach(() => {
    assignedStoreIds.splice(0, assignedStoreIds.length, ...configuredStoreIds);
    state.token = initialToken;
    resetRateLimitsForTests();
    let employeeNumber = 0;
    mock.method(EmployeeCounter, "findOneAndUpdate", async () => ({
      value: ++employeeNumber,
    }));
    mock.method(User, "findById", () =>
      queryResult({
        _id: userId,
        name: "Test",
        email: "test@example.test",
        role: "franchise_admin",
        sessionVersion: 0,
        isActive: true,
        franchises: assignedStoreIds,
      })
    );
    mock.method(Franchise, "find", () =>
      queryResult(
        assignedStoreIds.map((id) => ({
          _id: id,
          ...(options.franchise?.() ?? {}),
        }))
      )
    );
  });
  afterEach(() => mock.restoreAll());

  return async function call(method: string, path: string, body?: unknown) {
    const response = await fetch(`${state.url}${path}`, {
      method,
      headers: {
        Authorization: "Bearer " + state.token,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (method === "POST" && path === "/auth/select-store" && response.ok) {
      const result = (await response.clone().json()) as { token?: string };
      if (result.token) state.token = result.token;
    }
    return response;
  };
}
