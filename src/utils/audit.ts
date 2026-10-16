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