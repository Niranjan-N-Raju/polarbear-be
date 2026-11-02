import type { Request, Response } from "express";
import { authorizeStore } from "./storeAccess.js";

export const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isFranchiseAdmin(request: Request) {
  return request.auth?.role === "franchise_admin";
}

export function bodyRecord(request: Request): Record<string, unknown> {
  return request.body && typeof request.body === "object"
    ? (request.body as Record<string, unknown>)
    : {};
}

export async function requireStore(request: Request, response: Response) {
  const storeId = request.auth?.storeId;
  if (!storeId) {
    response.status(403).json({
      message: "Select an authorized store to continue.",
      code: "STORE_SELECTION_REQUIRED",
    });
    return null;
  }
  return authorizeStore(storeId, request.auth!.id, response);
}

export function stringQuery(request: Request, key: string) {
  const value = request.query[key];
  return typeof value === "string" ? value : undefined;
}

export function isPeriodValue(value: unknown): value is string {
  return typeof value === "string" && PERIOD_PATTERN.test(value);
}
