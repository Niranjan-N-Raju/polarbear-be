import bcrypt from "bcryptjs";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { LOGIN_RATE_MESSAGE, LoginUser, dummyHash } from '../services/auth.js';
import {
  checkRateLimit,
  peekRateLimit,
  rateLimits,
  recordRateLimitFailure,
  resetRateLimit,
  sendRateLimited
} from "../utils/rateLimit.js";
import { SESSION_ABSOLUTE_MAX_SECONDS, signSessionToken } from "../utils/token.js";
import { auditLog, emailHashPrefix } from "../utils/audit.js";
export async function postLogin(request: Request, response: Response) {
  // request.ip honours only the configured TRUST_PROXY hop count (1 by default on Vercel, whose edge
  // overwrites X-Forwarded-For), so clients cannot spoof their address via that header.
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

    // Unknown accounts still perform bcrypt work instead of returning before the costly comparison.
    const passwordMatches = await bcrypt.compare(
      password,
      typeof user?.password === "string" ? user.password : await dummyHash(),
    );
    if (!user || typeof user.password !== "string" || !passwordMatches) {
      recordRateLimitFailure(accountKey, rateLimits.loginAccountFailures);
      recordRateLimitFailure(accountGlobalKey, rateLimits.loginAccountGlobalFailures);
      recordRateLimitFailure(`login-ip-failures:${ip}`, rateLimits.loginIpFailures);
      auditLog("auth.login.failed", { ip, metadata: { emailHash: emailHashPrefix(normalizedEmail), reason: user ? "bad_password" : "unknown_account" } });
      response.status(401).json({ message: "Invalid email or password." });
      return;
    }

    if (user.role === "franchise_admin" || user.role === "employee") {
      if ((user.franchises ?? []).length === 0) {
        auditLog("auth.login.failed", { actorId: user._id.toString(), actorRole: user.role, ip, metadata: { emailHash: emailHashPrefix(normalizedEmail), reason: "no_store" } });
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
    auditLog("auth.login.succeeded", { actorId: user._id.toString(), actorRole: user.role, ip, metadata: { emailHash: emailHashPrefix(normalizedEmail) } });
    response.status(200).json({
      message: "Login successful.",
      token,
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
        mustChangePassword: user.mustChangePassword === true,
        preferredLanguage: user.preferredLanguage ?? "en",
      },
    });
  } catch {
    console.error("[auth.login] Authentication request failed.");
    response.status(500).json({ message: "An internal server error occurred." });
  }
}

export async function postExtend(request: Request, response: Response) {
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
  auditLog('auth.session.extended', { actorId: user.id, actorRole: user.role, ip: request.ip });
  response.json({ message: 'Session extended.', token });
}

export async function postLogout(request: Request, response: Response) {
  // Revocation is account-wide: all previously issued tokens carry the old version.
  // Await persistence before reporting success so a failed write cannot claim logout succeeded.
  await mongoose.connection.collection('users').updateOne(
    { _id: new mongoose.Types.ObjectId(request.auth!.id) },
    { $inc: { sessionVersion: 1 } },
  );
  auditLog('auth.logout', { actorId: request.auth!.id, actorRole: request.auth!.role, ip: request.ip });
  response.json({ message: 'Logged out.' });
}
