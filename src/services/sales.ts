import type { Types } from 'mongoose';
import { Sale } from '../models/Sale.js';
import { withSaleTotals } from '../utils/saleTotals.js';

export const MAX_INSIGHT_SALES = 400;

export async function getStoreSales(storeId: Types.ObjectId, range: { from: string; to: string }) {
  const sales = await Sale.find({
    franchise: storeId,
    date: { $gte: range.from, $lte: range.to },
  })
    .select('date totalSale swiggy zomato upi upiCharge cash expenses totalExpenses bankingCash')
    .sort({ date: -1 })
    .limit(MAX_INSIGHT_SALES)
    .lean();
  return sales.map(withSaleTotals);
}
