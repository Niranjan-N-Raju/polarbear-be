import mongoose from "mongoose";
import { decrypt } from "../utils/crypto.js";

export const DEFAULT_TABLES = Array.from({ length: 10 }, (_, index) => `T${index + 1}`);
export const GST_PERCENT = 5;
let indexPromise: Promise<void> | null = null;

export function pricePaise(price: unknown): number | null {
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0.01 || price > 1_000_000) return null;
  const paise = Math.round(price * 100);
  return Math.abs(price * 100 - paise) < 0.000001 ? paise : null;
}

export function billTotals(subtotalPaise: number) {
  const gstPaise = Math.round(subtotalPaise * GST_PERCENT / 100);
  return { subtotalPaise, gstPercent: GST_PERCENT, gstPaise, totalPaise: subtotalPaise + gstPaise };
}

export async function getBillingDatabase() {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Billing database is unavailable.");
  indexPromise ??= Promise.all([
    db.collection("bills").createIndex({ storeId: 1, createdAt: -1 }),
    db.collection("bills").createIndex({ storeId: 1, requestId: 1 }, { unique: true }),
    db.collection("bills").createIndex({ billNumber: 1 }, { unique: true }),
    db.collection("billing_tables").createIndex({ storeId: 1, tableNumber: 1 }, { unique: true }),
  ]).then(() => undefined).catch((error: unknown) => { indexPromise = null; throw error; });
  await indexPromise;
  return db;
}

export async function getServingTokens(storeId: string) {
  const rows = await (await getBillingDatabase()).collection("billing_tables").find({ storeId }).toArray();
  return [...new Set([...DEFAULT_TABLES, ...rows.map((row) => String(row.tableNumber))])]
    .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
}

export function serializeBill(bill: mongoose.mongo.Document) {
  return {
    _id: String(bill._id), billNumber: bill.billNumber, storeName: bill.storeName,
    orderType: bill.orderType, tableNumber: bill.tableNumber,
    items: bill.items.map((item: mongoose.mongo.Document) => ({
      productId: String(item.productId), name: item.name, quantity: item.quantity,
      unitPricePaise: item.unitPricePaise, amountPaise: item.amountPaise,
    })),
    subtotalPaise: bill.subtotalPaise, gstPercent: bill.gstPercent, gstPaise: bill.gstPaise,
    totalPaise: bill.totalPaise, createdAt: bill.createdAt,
    customer: bill.customer ? {
      mobile: decrypt(bill.customer.mobile), firstName: decrypt(bill.customer.firstName),
      middleName: decrypt(bill.customer.middleName), lastName: decrypt(bill.customer.lastName),
    } : null,
  };
}