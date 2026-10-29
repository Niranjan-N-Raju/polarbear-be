import bcrypt from 'bcryptjs';
import type { Request, Response } from 'express';
import { User } from '../models/User.js';
import { auditLog } from '../utils/audit.js';
import { checkRateLimit, rateLimits } from '../utils/rateLimit.js';
import { signSessionToken } from '../utils/token.js';
import { saveWebSession } from '../utils/webSession.js';
import { firstValidationMessage, passwordSchema, profileSchema } from '../utils/validation.js';

export async function get(request: Request, response: Response) {
  const user = await User.findById(request.auth!.id).select('_id name email role mustChangePassword preferredLanguage').lean();
  if (!user) {
    response.status(401).json({ message: 'Unauthorized' });
    return;
  }
  response.json({
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    mustChangePassword: user.mustChangePassword === true,
    preferredLanguage: user.preferredLanguage ?? 'en',
  });
}

export async function patch(request: Request, response: Response) {
  const auth = request.auth!;
  const rawBody = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
  const changingPassword = rawBody.newPassword !== undefined;
  // Only password changes consume the strict password budget; name/language edits use their own.
  const limit = changingPassword
    ? checkRateLimit(`password-change:${auth.id}`, rateLimits.passwordChange)
    : checkRateLimit(`profile-update:${auth.id}`, rateLimits.profileUpdate);
  if (!limit.allowed) {
    response.setHeader('Retry-After', String(Math.ceil((limit.retryAfterMs ?? 0) / 1000)));
    response.status(429).json({ message: 'Too many requests. Please try again later.' });
    return;
  }
  if (Buffer.byteLength(JSON.stringify(request.body ?? {}), 'utf8') > 10_000) {
    response.status(413).json({ message: 'Request body too large.' });
    return;
  }
  const parsed = profileSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ message: firstValidationMessage(parsed.error) });
    return;
  }

  const { name, preferredLanguage, currentPassword, newPassword } = parsed.data;
  if (newPassword !== undefined && !currentPassword) {
    response.status(400).json({ message: 'Current password is required to set a new password.' });
    return;
  }
  if (newPassword !== undefined) {
    const passwordResult = passwordSchema.safeParse(newPassword);
    if (!passwordResult.success) {
      response.status(400).json({ message: firstValidationMessage(passwordResult.error) });
      return;
    }
  }

  const user = await User.findById(auth.id).select('+password');
  if (!user) {
    response.status(404).json({ message: 'User not found.' });
    return;
  }
  if (name !== undefined) {
    const normalizedName = name.trim();
    if (!normalizedName) {
      response.status(400).json({ message: 'Name cannot be empty.' });
      return;
    }
    user.name = normalizedName;
  }
  if (preferredLanguage !== undefined) user.preferredLanguage = preferredLanguage;
  if (newPassword !== undefined) {
    if (!(await bcrypt.compare(currentPassword!, user.password!))) {
      response.status(400).json({ message: 'Current password is incorrect.' });
      return;
    }
    if (user.mustChangePassword === true && (await bcrypt.compare(newPassword, user.password!))) {
      response.status(400).json({ message: 'Choose a new password that differs from the one you were given.' });
      return;
    }
    user.password = await bcrypt.hash(newPassword, 12);
    // Invalidate every existing session after a password change; the response issues a fresh token.
    user.sessionVersion = (user.sessionVersion ?? 0) + 1;
    user.mustChangePassword = false;
  }
  if (name === undefined && preferredLanguage === undefined && newPassword === undefined) {
    response.status(400).json({ message: 'No fields to update.' });
    return;
  }

  await user.save();
  // Audit changed field names, never the supplied password values.
  auditLog(newPassword !== undefined ? 'user.password.changed' : 'user.profile.updated', {
    actorId: auth.id,
    actorRole: auth.role,
    ip: request.ip,
    metadata: { fields: Object.keys(parsed.data).filter((key) => key !== 'currentPassword' && key !== 'newPassword').concat(newPassword !== undefined ? ['password'] : []) },
  });
  const token = await signSessionToken({
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    sessionVersion: user.sessionVersion,
    // A password change starts a new session; other edits keep the original 24h absolute limit.
    ...(newPassword !== undefined ? {} : { sessionStart: auth.sessionStart }),
  });
  saveWebSession(request, response, token);
  response.json({ message: 'Profile updated', token, mustChangePassword: user.mustChangePassword === true });
}
