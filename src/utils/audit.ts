import { createHash } from 'node:crypto';

export interface AuditDetails {
  actorId?: string;
  actorRole?: string;
  targetId?: string;
  ip?: string;
  metadata?: Record<string, unknown>;
}

export function auditLog(action: string, details: AuditDetails): void {
  console.log(`[AUDIT] ${JSON.stringify({ timestamp: new Date().toISOString(), action, ...details })}`);
}

/** Short, non-reversible identifier for correlating audit events without logging the email address. */
export function emailHashPrefix(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 12);
}
