import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import mongoose from "mongoose";
import { User } from "../src/models/User.js";
import { queryResult, setupFranchiseApi, storeId, otherStoreId } from "./helpers/franchiseApi.js";

const assignedStores = [storeId, otherStoreId];
const call = setupFranchiseApi({ storeIds: assignedStores, initialStoreId: null });
const employeeId = new mongoose.Types.ObjectId();

describe("signed active store scope", () => {
  it("requires a validated selection for multi-store users and ignores spoofed IDs", async () => {
    let employeeFilter: Record<string, unknown> = {};
    mock.method(User, "find", (query: Record<string, unknown>) => {
      employeeFilter = query;
      return queryResult([]);
    });
    mock.method(User, "countDocuments", async () => 0);

    const unselected = await call("GET", `/users?storeId=${otherStoreId}`);
    assert.equal(unselected.status, 403);
    assert.equal(
      ((await unselected.json()) as { code: string }).code,
      "STORE_SELECTION_REQUIRED"
    );

    const deniedSwitch = await call("POST", "/auth/select-store", {
      storeId: new mongoose.Types.ObjectId().toString(),
    });
    assert.equal(deniedSwitch.status, 403);

    const selection = await call("POST", "/auth/select-store", {
      storeId: String(otherStoreId),
    });
    assert.equal(selection.status, 200);
    assert.equal(
      ((await selection.json()) as { storeId: string }).storeId,
      String(otherStoreId)
    );

    const scopedRead = await call("GET", `/users?storeId=${storeId}`);
    assert.equal(scopedRead.status, 200);
    assert.equal(String(employeeFilter.franchises), String(otherStoreId));
  });

  it("creates in the token store and prevents cross-store update/delete references", async () => {
    const selection = await call("POST", "/auth/select-store", {
      storeId: String(otherStoreId),
    });
    assert.equal(selection.status, 200);

    let created: Record<string, unknown> = {};
    mock.method(User, "create", async (input: Record<string, unknown>) => {
      created = input;
      return { _id: employeeId, employeeCode: "EMP0001" };
    });
    const createdResponse = await call(
      "POST",
      `/users?storeId=${storeId}`,
      { name: "Scoped employee", storeId: String(storeId) }
    );
    assert.equal(createdResponse.status, 201);
    assert.deepEqual(created.franchises, [otherStoreId]);

    let targetFilter: Record<string, unknown> = {};
    mock.method(User, "findOne", (query: Record<string, unknown>) => {
      targetFilter = query;
      return queryResult(null);
    });
    const patch = await call(
      "PATCH",
      `/users/${employeeId}?storeId=${storeId}`,
      { name: "Cross-store update" }
    );
    assert.equal(patch.status, 404);
    assert.equal(String(targetFilter.franchises), String(otherStoreId));

    const remove = await call(
      "DELETE",
      `/users/${employeeId}?storeId=${storeId}`,
      { exitDate: "2026-01-03" }
    );
    assert.equal(remove.status, 404);
    assert.equal(String(targetFilter.franchises), String(otherStoreId));
  });

  it("revokes the selected scope when the store assignment changes", async () => {
    const selection = await call("POST", "/auth/select-store", {
      storeId: String(otherStoreId),
    });
    assert.equal(selection.status, 200);

    assignedStores.splice(0, assignedStores.length, storeId);
    const response = await call("GET", `/users?storeId=${storeId}`);
    assert.equal(response.status, 403);
    assert.equal(
      ((await response.json()) as { code: string }).code,
      "STORE_SELECTION_REQUIRED"
    );
  });
});
