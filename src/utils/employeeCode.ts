import mongoose, { Schema } from 'mongoose';

const schema = new Schema<{ _id: string; value: number }>(
  { _id: { type: String, required: true }, value: { type: Number, required: true, min: 0 } },
  { collection: 'employee_counters', versionKey: false },
);

export const EmployeeCounter = (mongoose.models.EmployeeCounter as mongoose.Model<{ _id: string; value: number }> | undefined)
  ?? mongoose.model('EmployeeCounter', schema);

export async function nextEmployeeCode(): Promise<string> {
  const counter = await EmployeeCounter.findOneAndUpdate(
    { _id: 'employee' },
    { $inc: { value: 1 } },
    { new: true, upsert: true },
  );
  if (!counter || !Number.isSafeInteger(counter.value) || counter.value < 1) throw new Error('Unable to allocate employee ID.');
  return `EMP${String(counter.value).padStart(4, '0')}`;
}