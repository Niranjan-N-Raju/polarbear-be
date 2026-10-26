import { Router } from "express";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { requireAuth } from "../middleware/auth.js";
import { SESSION_ABSOLUTE_MAX_SECONDS, signSessionToken } from "../utils/token.js";

interface LoginUser {
  _id: mongoose.Types.ObjectId;
  email: string;
  password: string;
  name: string;
  role: "admin" | "sub_admin" | "franchise_admin" | "employee";
  isActive?: boolean;
  sessionVersion?: number;
  franchises?: unknown[];
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const rateLimits = new Map<string, RateLimitEntry>();

function checkRateLimit(key: string): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  let entry = rateLimits.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    rateLimits.set(key, entry);
  }
  if (rateLimits.size > 1000) {
    for (const [storedKey, storedEntry] of rateLimits) {
      if (storedEntry.resetAt <= now) rateLimits.delete(storedKey);
    }
  }
  if (entry.count >= MAX_ATTEMPTS) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count += 1;
  return { allowed: true, retryAfter: 0 };
}

export const authRouter = Router();

authRouter.post("/login", async (request: Request, response: Response) => {
  const ip = request.ip || "unknown";
  const ipLimit = checkRateLimit(`login:${ip}`);
  if (!ipLimit.allowed) {
    response.setHeader("Retry-After", String(ipLimit.retryAfter));
    response.status(429).json({ message: "Too many login attempts. Please try again later." });
    return;
  }

  const body: unknown = request.body;
  if (!body || typeof body !== "object") {
    response.status(400).json({ message: "Invalid input." });
    return;
  }
  const { email, password } = body as Record<string, unknown>;
  if (
    typeof email !== "string" ||
    email.trim().length === 0 ||
    email.length > 254 ||
    typeof password !== "string" ||
    password.length === 0 ||
    password.length > 200
  ) {
    response.status(400).json({ message: "Email and password are required." });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();
  const accountLimit = checkRateLimit(`login-account:${normalizedEmail}`);
  if (!accountLimit.allowed) {
    response.setHeader("Retry-After", String(accountLimit.retryAfter));
    response.status(429).json({ message: "Too many login attempts. Please try again later." });
    return;
  }

  try {
    const users = mongoose.connection.collection("users");
    const user = (await users.findOne({
      email: normalizedEmail,
      isActive: { $ne: false },
    })) as LoginUser | null;

    if (!user || !(await bcrypt.compare(password, user.password))) {
      response.status(401).json({ message: "Invalid email or password." });
      return;
    }

    if (user.role === "franchise_admin" || user.role === "employee") {
      if ((user.franchises ?? []).length === 0) {
        response.status(403).json({ message: "No stores are associated with this user." });
        return;
      }
    }

    rateLimits.delete(`login:${ip}`);
    rateLimits.delete(`login-account:${normalizedEmail}`);
    const token = await signSessionToken({
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role,
      sessionVersion: user.sessionVersion,
    });
    response.status(200).json({
      message: "Login successful.",
      token,
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch {
    console.error("[auth.login] Authentication request failed.");
    response.status(500).json({ message: "An internal server error occurred." });
  }
});

authRouter.post('/extend', requireAuth, async (request, response) => {
  const user = request.auth!;
  if (Math.floor(Date.now() / 1000) - user.sessionStart >= SESSION_ABSOLUTE_MAX_SECONDS) {
    response.status(401).json({ message: 'Session expired. Please sign in again.' });
    return;
  }
  const updated = await mongoose.connection.collection('users').findOne({
    _id: new mongoose.Types.ObjectId(user.id),
    isActive: { $ne: false },
  });
  if (!updated || updated.role !== user.role || (updated.sessionVersion ?? 0) !== user.sessionVersion) {
    response.status(401).json({ message: 'Session expired.' });
    return;
  }
  const token = await signSessionToken({
    id: user.id,
    name: String(updated.name ?? user.name ?? ''),
    email: String(updated.email ?? user.email ?? ''),
    role: String(updated.role),
    sessionVersion: user.sessionVersion,
    sessionStart: user.sessionStart,
  });
  response.json({ message: 'Session extended.', token });
});

authRouter.post('/logout', requireAuth, async (request, response) => {
  await mongoose.connection.collection('users').updateOne(
    { _id: new mongoose.Types.ObjectId(request.auth!.id) },
    { $inc: { sessionVersion: 1 } },
  );
  response.json({ message: 'Logged out.' });
});