import bcrypt from "bcryptjs";
import mongoose from "mongoose";
export interface LoginUser {
  _id: mongoose.Types.ObjectId;
  email: string;
  password: string;
  name: string;
  role: "admin" | "sub_admin" | "franchise_admin" | "employee";
  preferredLanguage?: "en" | "kn";
  isActive?: boolean;
  sessionVersion?: number;
  franchises?: unknown[];
  mustChangePassword?: boolean;
}
export const LOGIN_RATE_MESSAGE = "Too many login attempts. Please try again later.";
export let dummyHashPromise: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummyHashPromise ??= bcrypt.hash("polar-bear-dummy-password", 12);
  return dummyHashPromise;
}
