import mongoose from 'mongoose';
import { connectToDatabase, disconnectFromDatabase } from '../src/config/database.js';
import { loadConfig } from '../src/config/env.js';
import { User } from '../src/models/User.js';
import { EmployeeCounter, nextEmployeeCode } from '../src/utils/employeeCode.js';

const apply = process.argv.includes('--apply');

async function main(): Promise<void> {
  await connectToDatabase(loadConfig());
  try {
    const employees = await User.find({ role: 'employee' }).select('_id createdAt employeeCode').lean();
    const codes = new Set<string>();
    const counter = await EmployeeCounter.findById('employee').lean();
    let maximum = counter?.value ?? 0;
    if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error('Invalid employee ID counter.');
    for (const employee of employees) {
      if (!employee.employeeCode) continue;
      if (!/^EMP\d{4,}$/.test(employee.employeeCode) || codes.has(employee.employeeCode)) {
        throw new Error('Existing employee IDs are invalid or duplicated. No IDs were changed.');
      }
      codes.add(employee.employeeCode);
      const value = Number(employee.employeeCode.slice(3));
      if (!Number.isSafeInteger(value)) throw new Error('Existing employee ID exceeds the supported range.');
      maximum = Math.max(maximum, value);
    }
    const insertionTime = (employee: typeof employees[number]) => {
      const createdAt = employee.createdAt ? new Date(employee.createdAt).getTime() : NaN;
      return Number.isFinite(createdAt) ? createdAt : employee._id.getTimestamp().getTime();
    };
    const missing = employees.filter((employee) => !employee.employeeCode).sort((first, second) =>
      insertionTime(first) - insertionTime(second) || String(first._id).localeCompare(String(second._id)),
    );
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', employees: employees.length, existingIds: codes.size, missingIds: missing.length, nextId: `EMP${String(maximum + 1).padStart(4, '0')}` }));
    if (!apply) {
      console.log('Dry run only. Pause employee creation in both apps, back up the database, then re-run with --apply.');
      return;
    }
    await EmployeeCounter.updateOne({ _id: 'employee' }, { $max: { value: maximum } }, { upsert: true });
    let assigned = 0;
    for (const employee of missing) {
      const employeeCode = await nextEmployeeCode();
      const result = await mongoose.connection.collection('users').updateOne(
        { _id: employee._id, role: 'employee', $or: [{ employeeCode: { $exists: false } }, { employeeCode: null }, { employeeCode: '' }] },
        { $set: { employeeCode } },
      );
      assigned += result.modifiedCount;
    }
    await mongoose.connection.collection('users').createIndex(
      { employeeCode: 1 },
      { unique: true, partialFilterExpression: { employeeCode: { $type: 'string' } } },
    );
    console.log(JSON.stringify({ assigned, unchanged: employees.length - assigned, uniqueIndexCreated: true }));
  } finally {
    await disconnectFromDatabase();
  }
}

main().catch((error: unknown) => {
  console.error('Employee ID migration failed:', error instanceof Error ? error.name : 'unknown error');
  process.exitCode = 1;
});