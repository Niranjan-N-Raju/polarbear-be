import type mongoose from 'mongoose';
import { connectToDatabase, disconnectFromDatabase } from '../src/config/database.js';
import { loadConfig } from '../src/config/env.js';
import { Advance } from '../src/models/Advance.js';
import { Attendance } from '../src/models/Attendance.js';
import { AttendanceRemoval } from '../src/models/AttendanceRemoval.js';
import { ExtraDay } from '../src/models/ExtraDay.js';
import { Franchise } from '../src/models/Franchise.js';
import { Incentive } from '../src/models/Incentive.js';
import { DumpedInventory, InventoryItem, Product } from '../src/models/Inventory.js';
import { PnlInput } from '../src/models/PnlInput.js';
import { Sale } from '../src/models/Sale.js';
import { User } from '../src/models/User.js';
import { WeeklyRoster } from '../src/models/WeeklyRoster.js';
import { Withdrawal } from '../src/models/Withdrawal.js';

// autoIndex is disabled at runtime, so declared indexes must be created explicitly once per environment.
// Usage: npm run db:sync-indexes            (dry run: lists missing index names)
//        npm run db:sync-indexes -- --apply (creates missing indexes; never drops existing ones)
const isApply = process.argv.includes('--apply');

const MODELS: mongoose.Model<any>[] = [
  User, Franchise, Sale, Attendance, AttendanceRemoval, WeeklyRoster, Advance, Incentive, ExtraDay,
  PnlInput, Withdrawal, Product, InventoryItem, DumpedInventory,
];

function indexName(keys: Record<string, unknown>, options: { name?: string }): string {
  return options.name ?? Object.entries(keys).map(([field, direction]) => `${field}_${String(direction)}`).join('_');
}

async function existingIndexNames(model: mongoose.Model<any>): Promise<Set<string>> {
  try {
    const indexes = await model.listIndexes();
    return new Set(indexes.map((index) => String(index.name)));
  } catch {
    // The collection does not exist yet.
    return new Set();
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  await connectToDatabase(config);
  let failures = 0;
  try {
    for (const model of MODELS) {
      const declared = model.schema.indexes().map(([keys, options]) => indexName(keys as Record<string, unknown>, options as { name?: string }));
      const existing = await existingIndexNames(model);
      const missing = declared.filter((name) => !existing.has(name));
      const label = `${model.modelName} (${model.collection.collectionName})`;
      if (!isApply) {
        console.log(`${label}: ${missing.length ? `missing ${missing.join(', ')}` : 'up to date'}`);
        continue;
      }
      try {
        await model.createIndexes();
        console.log(`${label}: ${missing.length ? `created ${missing.join(', ')}` : 'up to date'}`);
      } catch (error) {
        failures += 1;
        // Error messages can contain duplicate key values (e.g. emails); print only the error type/code.
        const code = (error as { code?: unknown }).code;
        console.error(`${label}: index creation failed (${error instanceof Error ? error.name : 'Error'}${code === undefined ? '' : ` code ${String(code)}`}).`);
      }
    }
    if (!isApply) console.log('Dry run only. Re-run with --apply to create missing indexes.');
  } finally {
    await disconnectFromDatabase();
  }
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('Index sync failed:', error instanceof Error ? error.name : 'unknown error');
  process.exitCode = 1;
});
