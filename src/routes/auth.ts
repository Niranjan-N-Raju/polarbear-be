import { Router } from "express";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { requireAuth } from "../middleware/auth.js";
import { SESSION_ABSOLUTE_MAX_SECONDS, signSessionToken } from "../utils/token.js";
import {
  byUser,
  checkRateLimit,
  peekRateLimit,
  rateLimitMiddleware,
  rateLimits,
  recordRateLimitFailure,
  resetRateLimit,
  sendRateLimited,
} from "../utils/rateLimit.js";

interface LoginUser {
  _id: mongoose.Types.ObjectId;
  email: string;
  password: string;
  name: string;
  role: "admin" | "sub_admin" | "franchise_admin" | "employee";
  isActive?: boolean;
  sessionVersion?: number;
  franchises?: unknown[];
  mustChangePassword?: boolean;
}

const LOGIN_RATE_MESSAGE = "Too many login attempts. Please try again later.";
let dummyHashPromise: Promise<string> | undefined;

// Unknown accounts still pay for a bcrypt compare so response timing does not reveal which emails exist.
function dummyHash(): Promise<string> {
  dummyHashPromise ??= bcrypt.hash("polar-bear-dummy-password", 12);
  return dummyHashPromise;
}

export const authRouter = Router();

authRouter.post("/login", async (request: Request, response: Response) => {
  // request.ip honours only the configured TRUST_PROXY hop count, so X-Forwarded-For cannot be spoofed.
  const ip = request.ip || request.socket.remoteAddress || "unknown";
  const ipAttempts = checkRateLimit(`login-ip-attempts:${ip}`, rateLimits.loginIpAttempts);
  const ipFailures = peekRateLimit(`login-ip-failures:${ip}`);
  if (!ipAttempts.allowed || !ipFailures.allowed) {
    sendRateLimited(response, ipAttempts.retryAfterMs ?? ipFailures.retryAfterMs, LOGIN_RATE_MESSAGE);
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
  // Lockout is keyed per (account, IP) so a third party cannot lock a user out from elsewhere;
  // a separate, much higher per-account ceiling still caps distributed guessing.
  const accountKey = `login-account-ip-failures:${normalizedEmail}:${ip}`;
  const accountGlobalKey = `login-account-failures:${normalizedEmail}`;
  for (const key of [accountKey, accountGlobalKey]) {
    const accountLimit = peekRateLimit(key);
    if (!accountLimit.allowed) {
      sendRateLimited(response, accountLimit.retryAfterMs, LOGIN_RATE_MESSAGE);
      return;
    }
  }

  try {
    const users = mongoose.connection.collection("users");
    const user = (await users.findOne({
      email: normalizedEmail,
      isActive: { $ne: false },
    })) as LoginUser | null;

    const passwordMatches = await bcrypt.compare(
      password,
      typeof user?.password === "string" ? user.password : await dummyHash(),
    );
    if (!user || typeof user.password !== "string" || !passwordMatches) {
      recordRateLimitFailure(accountKey, rateLimits.loginAccountFailures);
      recordRateLimitFailure(accountGlobalKey, rateLimits.loginAccountGlobalFailures);
      recordRateLimitFailure(`login-ip-failures:${ip}`, rateLimits.loginIpFailures);
      response.status(401).json({ message: "Invalid email or password." });
      return;
    }

    if (user.role === "franchise_admin" || user.role === "employee") {
      if ((user.franchises ?? []).length === 0) {
        response.status(403).json({ message: "No stores are associated with this user." });
        return;
      }
    }

    // Only the account failure counter resets; per-IP budgets are never cleared by a success,
    // so an attacker with one valid account cannot reset their IP throttle.
    resetRateLimit(accountKey);
    resetRateLimit(accountGlobalKey);
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
        mustChangePassword: user.mustChangePassword === true,
      },
    });
  } catch {
    console.error("[auth.login] Authentication request failed.");
    response.status(500).json({ message: "An internal server error occurred." });
  }
});

authRouter.post('/extend', requireAuth, rateLimitMiddleware('session-extend', rateLimits.sessionExtend, byUser), async (request, response) => {
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

authRouter.post('/logout', requireAuth, rateLimitMiddleware('logout', rateLimits.logout, byUser), async (request, response) => {
  await mongoose.connection.collection('users').updateOne(
    { _id: new mongoose.Types.ObjectId(request.auth!.id) },
    { $inc: { sessionVersion: 1 } },
  );
  response.json({ message: 'Logged out.' });
});