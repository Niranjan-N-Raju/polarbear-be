import { randomBytes, randomInt } from 'node:crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { connectToDatabase, disconnectFromDatabase } from '../src/config/database.js';
import { loadConfig } from '../src/config/env.js';
import { Franchise } from '../src/models/Franchise.js';
import { User } from '../src/models/User.js';

const DEMO_STORE_COUNT = 50;
const DEMO_USER_COUNT = 50;
const isApply = process.argv.includes('--apply');
const allowRemote = process.argv.includes('--allow-remote');

function isLocalMongoUri(uri: string): boolean {
  try {
    const hostname = new URL(uri).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function chooseStoreIds(storeIds: mongoose.Types.ObjectId[]): mongoose.Types.ObjectId[] {
  const available = [...storeIds];
  const assignmentCount = randomInt(1, 3);
  const selected: mongoose.Types.ObjectId[] = [];
  while (selected.length < assignmentCount && available.length > 0) {
    selected.push(available.splice(randomInt(available.length), 1)[0]);
  }
  return selected;
}

async function seedDemoData(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Demo data seeding is disabled when NODE_ENV=production.');
  }

  const config = loadConfig();
  const localDatabase = isLocalMongoUri(config.mongoUri);
  if (isApply && !localDatabase && !allowRemote) {
    throw new Error('Refusing to write to a non-local database. Review the target, then pass --allow-remote to confirm.');
  }

  await connectToDatabase(config);
  try {
    const admin = await User.findOne({ role: 'admin', isActive: { $ne: false } }).select('_id').lean();
    if (!admin) {
      throw new Error('No active admin account was found. Create an admin account before seeding demo records.');
    }

    const storeCodes = Array.from({ length: DEMO_STORE_COUNT }, (_, index) => `DEMO${String(index + 1).padStart(3, '0')}`);
    const existingStores = await Franchise.find({ storeCode: { $in: storeCodes } }).select('_id storeCode createdBy').lean();
    const foreignStore = existingStores.find((store) => String(store.createdBy ?? '') !== String(admin._id));
    if (foreignStore) {
      throw new Error(`Store code ${foreignStore.storeCode} already exists and is not owned by the selected admin. No records were changed.`);
    }

    const existingDemoUsers = await User.find({
      email: { $in: Array.from({ length: DEMO_USER_COUNT }, (_, index) => `demo.user${String(index + 1).padStart(2, '0')}@example.test`) },
    }).select('_id email franchises createdBy').lean();
    const foreignUser = existingDemoUsers.find((user) => String(user.createdBy ?? '') !== String(admin._id));
    if (foreignUser) {
      throw new Error(`Demo email ${foreignUser.email} is not owned by the selected admin. No records were changed.`);
    }
    const existingEmails = new Set(existingDemoUsers.map((user) => user.email));
    const usersNeedingStoreAssignments = existingDemoUsers.filter(
      (user) => user.franchises.length < 1 || user.franchises.length > 2,
    );
    const existingStoreCodes = new Set(existingStores.map((store) => store.storeCode));
    const missingStoreCount = storeCodes.filter((code) => !existingStoreCodes.has(code)).length;
    const missingUserCount = DEMO_USER_COUNT - existingEmails.size;

    console.log(`Database: ${config.mongoDatabase} (${localDatabase ? 'local' : 'remote'})`);
    console.log('Admin ownership: confirmed.');
    console.log(`Demo stores: ${missingStoreCount} to add, ${DEMO_STORE_COUNT - missingStoreCount} already present.`);
    console.log(`Demo users: ${missingUserCount} to add, ${existingEmails.size} already present.`);
    console.log(`Existing demo users needing store assignments: ${usersNeedingStoreAssignments.length}.`);
    if (!isApply) {
      console.log('Preview only. Pass --apply to insert missing demo records.');
      return;
    }

    const storeIds = new Map<string, mongoose.Types.ObjectId>(
      existingStores.map((store) => [store.storeCode, store._id]),
    );
    for (let index = 0; index < DEMO_STORE_COUNT; index += 1) {
      const number = index + 1;
      const storeCode = storeCodes[index];
      if (storeIds.has(storeCode)) continue;

      const storeType = number % 3 === 0 ? 'company' : 'franchise';
      const active = number % 5 !== 0;
      const franchise = await Franchise.create({
        name: `Demo ${storeType === 'company' ? 'Company' : 'Franchise'} Store ${String(number).padStart(2, '0')}`,
        storeCode,
        storeType,
        description: `Sample ${storeType} location for testing store management.`,
        address: `${number} Demo Street, Test City`,
        phone: `555${String(number).padStart(7, '0')}`,
        ...(storeType === 'franchise' ? {
          ownerName: `Demo Owner ${String(number).padStart(2, '0')}`,
          ownerPhone: `556${String(number).padStart(7, '0')}`,
          ownerEmail: `demo.owner${String(number).padStart(2, '0')}@example.test`,
        } : {}),
        isActive: active,
        ...(active ? {} : { archivedAt: new Date('2025-01-01T00:00:00.000Z') }),
        createdBy: admin._id,
      });
      storeIds.set(storeCode, franchise._id);
    }

    const availableStoreIds = [...storeIds.values()];
    for (const user of usersNeedingStoreAssignments) {
      await User.updateOne(
        { _id: user._id },
        { $set: { franchises: chooseStoreIds(availableStoreIds) } },
      );
    }

    for (let index = 0; index < DEMO_USER_COUNT; index += 1) {
      const number = index + 1;
      const email = `demo.user${String(number).padStart(2, '0')}@example.test`;
      if (existingEmails.has(email)) continue;

      const role = number <= 12 && number % 2 !== 0 ? 'sub_admin' : 'franchise_admin';
      const franchises = chooseStoreIds(availableStoreIds);
      if (franchises.length === 0) {
        throw new Error('No demo stores were available for user assignment.');
      }
      await User.create({
        name: `Demo User ${String(number).padStart(2, '0')}`,
        email,
        password: await bcrypt.hash(randomBytes(32).toString('hex'), 12),
        role,
        isActive: number % 6 !== 0,
        createdBy: admin._id,
        franchises,
      });
    }

    console.log(`Inserted ${missingStoreCount} demo stores and ${missingUserCount} demo users; assigned stores to ${usersNeedingStoreAssignments.length} existing demo users.`);
  } finally {
    await disconnectFromDatabase();
  }
}

seedDemoData().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Demo data seeding failed.');
  process.exitCode = 1;
});
