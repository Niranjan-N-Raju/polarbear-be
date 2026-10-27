import { ENCRYPTED_USER_FIELDS, encrypt, isEncrypted } from './crypto.js';

type EncryptedField = (typeof ENCRYPTED_USER_FIELDS)[number];

export interface LegacyPiiPlan {
  /** Fields to $set with their encrypted values. */
  set: Partial<Record<EncryptedField, string>>;
  /** Original plaintext values, used as an optimistic-concurrency guard in the update filter. */
  guard: Partial<Record<EncryptedField, string>>;
}

export interface LegacyPiiStats {
  scanned: number;
  documentsNeedingUpdate: number;
  documentsUpdated: number;
  documentsSkippedConcurrent: number;
  fieldsEncrypted: Record<EncryptedField, number>;
}

export function requireFieldEncryptionKey(): void {
  if (!/^[0-9a-fA-F]{64}$/.test(process.env.FIELD_ENCRYPTION_KEY ?? '')) {
    throw new Error('FIELD_ENCRYPTION_KEY (64 hex characters) is required to run the PII migration.');
  }
}

/** Returns the update needed for one user document, or null if nothing is plaintext. Idempotent. */
export function planLegacyPiiEncryption(doc: Record<string, unknown>): LegacyPiiPlan | null {
  const set: LegacyPiiPlan['set'] = {};
  const guard: LegacyPiiPlan['guard'] = {};
  for (const field of ENCRYPTED_USER_FIELDS) {
    const value = doc[field];
    if (typeof value !== 'string' || value === '' || isEncrypted(value)) continue;
    set[field] = encrypt(value);
    guard[field] = value;
  }
  return Object.keys(set).length > 0 ? { set, guard } : null;
}

export interface UsersCollectionLike {
  find(
    filter: Record<string, unknown>,
    options: { projection: Record<string, 1> },
  ): AsyncIterable<Record<string, unknown>>;
  updateOne(
    filter: Record<string, unknown>,
    update: { $set: Record<string, string> },
  ): Promise<{ modifiedCount: number }>;
}

/**
 * Encrypts legacy plaintext PII on the raw users collection (no Mongoose hooks run).
 * Dry run only counts; it never returns or logs field values.
 */
export async function migrateLegacyPii(
  users: UsersCollectionLike,
  options: { dryRun: boolean },
): Promise<LegacyPiiStats> {
  requireFieldEncryptionKey();
  const fieldsEncrypted = Object.fromEntries(ENCRYPTED_USER_FIELDS.map((f) => [f, 0])) as Record<
    EncryptedField,
    number
  >;
  const stats: LegacyPiiStats = {
    scanned: 0,
    documentsNeedingUpdate: 0,
    documentsUpdated: 0,
    documentsSkippedConcurrent: 0,
    fieldsEncrypted,
  };
  const projection = Object.fromEntries(ENCRYPTED_USER_FIELDS.map((f) => [f, 1 as const]));
  const filter = {
    $or: ENCRYPTED_USER_FIELDS.map((f) => ({ [f]: { $type: 'string', $nin: [''], $not: /^enc:/ } })),
  };

  for await (const doc of users.find(filter, { projection })) {
    stats.scanned += 1;
    const plan = planLegacyPiiEncryption(doc);
    if (!plan) continue;
    stats.documentsNeedingUpdate += 1;
    if (options.dryRun) {
      for (const field of Object.keys(plan.set) as EncryptedField[]) stats.fieldsEncrypted[field] += 1;
      continue;
    }
    const result = await users.updateOne({ _id: doc._id, ...plan.guard }, { $set: plan.set });
    if (result.modifiedCount === 1) {
      stats.documentsUpdated += 1;
      for (const field of Object.keys(plan.set) as EncryptedField[]) stats.fieldsEncrypted[field] += 1;
    } else {
      stats.documentsSkippedConcurrent += 1;
    }
  }
  return stats;
}
