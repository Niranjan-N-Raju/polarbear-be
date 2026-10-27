import mongoose from 'mongoose';
import { connectToDatabase, disconnectFromDatabase } from '../src/config/database.js';
import { loadConfig } from '../src/config/env.js';
import { migrateLegacyPii, requireFieldEncryptionKey, type UsersCollectionLike } from '../src/utils/piiMigration.js';

// Usage: npm run migrate:encrypt-pii            (dry run, counts only)
//        npm run migrate:encrypt-pii -- --apply (writes encrypted values)
const isApply = process.argv.includes('--apply');

async function main(): Promise<void> {
  const config = loadConfig();
  requireFieldEncryptionKey();
  await connectToDatabase(config);
  try {
    const users = mongoose.connection.collection('users') as unknown as UsersCollectionLike;
    const stats = await migrateLegacyPii(users, { dryRun: !isApply });
    console.log(JSON.stringify({ mode: isApply ? 'apply' : 'dry-run', ...stats }, null, 2));
    if (!isApply && stats.documentsNeedingUpdate > 0) {
      console.log('Dry run only. Re-run with --apply after backing up the database.');
    }
  } finally {
    await disconnectFromDatabase();
  }
}

main().catch((error: unknown) => {
  console.error('PII migration failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});
