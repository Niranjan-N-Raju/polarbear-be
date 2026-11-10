import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { Franchise } from "../models/Franchise.js";
import { billTotals, DEFAULT_TABLES, getBillingDatabase, getServingTokens, pricePaise, serializeBill } from "../services/billing.js";
import { businessDateValue } from "../utils/dateUtils.js";
import { encrypt } from "../utils/crypto.js";
import { bodyRecord, requireStore, stringQuery } from "../utils/franchiseRoute.js";
import { isDateValue } from "../utils/storeAccess.js";

const { ObjectId } = mongoose.mongo;

async function billingAccess(request: Request, response: Response) {
  const id = await requireStore(request, response);
  if (!id) return null;
  const store = await Franchise.findById(id).select("name isActive archivedAt").lean();
  if (!store || store.isActive === false || store.archivedAt) {
    response.status(403).json({ message: "This store is no longer available for billing." });
    return null;
  }
  return { storeId: String(id), storeName: store.name };
}

export async function getBillingTables(request: Request, response: Response) {
  const access = await billingAccess(request, response);
  if (access) response.json({ tables: await getServingTokens(access.storeId) });
}

export async function postBillingTable(request: Request, response: Response) {
  const access = await billingAccess(request, response);
  if (!access) return;
  const raw = bodyRecord(request).tableNumber;
  const tableNumber = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!/^T[1-9]\d{0,3}$/.test(tableNumber)) {
    response.status(400).json({ message: "Enter a table number from T1 to T9999." });
    return;
  }
  if (DEFAULT_TABLES.includes(tableNumber)) {
    response.status(409).json({ message: "That table already exists." });
    return;
  }
  try {
    await (await getBillingDatabase()).collection("billing_tables").insertOne({
      storeId: access.storeId, tableNumber, createdBy: request.auth!.id, createdAt: new Date(),
    });
    response.status(201).json({ tableNumber });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) { response.status(409).json({ message: "That table already exists." }); return; }
    throw error;
  }
}

export async function getBills(request: Request, response: Response) {
  const access = await billingAccess(request, response);
  if (!access) return;
  if (stringQuery(request, "newRequest") === "true") { response.json({ requestId: randomUUID() }); return; }
  const db = await getBillingDatabase();
  const billId = stringQuery(request, "billId");
  if (billId !== undefined) {
    if (!ObjectId.isValid(billId)) { response.status(400).json({ message: "Invalid bill." }); return; }
    const bill = await db.collection("bills").findOne({ _id: new ObjectId(billId), storeId: access.storeId });
    if (!bill) { response.status(404).json({ message: "Bill not found." }); return; }
    response.json({ bill: serializeBill(bill) });
    return;
  }
  if (stringQuery(request, "view") === "history") {
    const today = businessDateValue();
    const from = stringQuery(request, "from") ?? today;
    const to = stringQuery(request, "to") ?? today;
    const orderType = stringQuery(request, "orderType") ?? "";
    const tableNumber = stringQuery(request, "tableNumber") ?? "";
    const search = (stringQuery(request, "search") ?? "").trim();
    const pageValue = stringQuery(request, "page") ?? "1";
    const page = Number(pageValue);
    if (!isDateValue(from) || !isDateValue(to) || from > to || !/^\d+$/.test(pageValue) || !Number.isSafeInteger(page) || page < 1 || page > 10000 ||
        (orderType !== "" && orderType !== "dineIn" && orderType !== "takeAway") || (tableNumber !== "" && !/^T[1-9]\d{0,3}$/.test(tableNumber)) || search.length > 80) {
      response.status(400).json({ message: "Choose a valid date range and billing filters." }); return;
    }
    const filter = {
      storeId: access.storeId,
      createdAt: { $gte: new Date(`${from}T00:00:00+05:30`), $lt: new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86_400_000) },
      ...(orderType ? { orderType } : {}), ...(tableNumber ? { tableNumber } : {}),
      ...(search ? { billNumber: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } } : {}),
    };
    const pageSize = 25;
    const [bills, total, tables] = await Promise.all([
      db.collection("bills").find(filter, { projection: { billNumber: 1, orderType: 1, tableNumber: 1, totalPaise: 1, createdAt: 1 } }).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      db.collection("bills").countDocuments(filter), getServingTokens(access.storeId),
    ]);
    response.json({ storeName: access.storeName, bills: bills.map((bill) => ({ ...bill, _id: String(bill._id) })), tables, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
    return;
  }
  const [products, categories, tables] = await Promise.all([
    db.collection("menu_products").find({}).sort({ name: 1 }).toArray(),
    db.collection("product_categories").find({}).toArray(), getServingTokens(access.storeId),
  ]);
  const names = new Map(categories.map((category) => [String(category._id), category.name]));
  response.json({ storeName: access.storeName, tables, products: products.map((product) => ({
    _id: String(product._id), name: product.name, category: names.get(String(product.categoryId)) ?? "Uncategorized",
    price: pricePaise(product.price) === null ? null : product.price,
  })) });
}

export async function postBill(request: Request, response: Response) {
  const access = await billingAccess(request, response);
  if (!access) return;
  const body = bodyRecord(request);
  if (typeof body.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)) {
    response.status(400).json({ message: "A valid billing request is required." }); return;
  }
  const db = await getBillingDatabase();
  const existing = await db.collection("bills").findOne({ storeId: access.storeId, requestId: body.requestId });
  if (existing) { response.json({ bill: serializeBill(existing) }); return; }
  if (body.orderType !== "dineIn" && body.orderType !== "takeAway") { response.status(400).json({ message: "Choose dine-in or takeaway." }); return; }
  const tableNumber = typeof body.tableNumber === "string" ? body.tableNumber : "";
  if (!/^T[1-9]\d{0,3}$/.test(tableNumber) || !(await getServingTokens(access.storeId)).includes(tableNumber)) {
    response.status(400).json({ message: "Choose a valid serving token in this store." }); return;
  }
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100) { response.status(400).json({ message: "Choose between 1 and 100 products." }); return; }
  const requested: { productId: string; quantity: number }[] = [];
  for (const entry of body.items) {
    if (!entry || typeof entry !== "object") { response.status(400).json({ message: "Invalid bill item." }); return; }
    const { productId, quantity } = entry as Record<string, unknown>;
    if (typeof productId !== "string" || !ObjectId.isValid(productId) || typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      response.status(400).json({ message: "Choose valid products and whole quantities from 1 to 999." }); return;
    }
    requested.push({ productId: new ObjectId(productId).toHexString(), quantity });
  }
  if (new Set(requested.map((item) => item.productId)).size !== requested.length) { response.status(400).json({ message: "Combine repeated products into a single quantity." }); return; }
  const products = await db.collection("menu_products").find({ _id: { $in: requested.map((item) => new ObjectId(item.productId)) } }).toArray();
  const items = [];
  for (const item of requested) {
    const product = products.find((candidate) => String(candidate._id) === item.productId);
    const unitPricePaise = pricePaise(product?.price);
    if (!product || unitPricePaise === null) { response.status(409).json({ message: "A product has no price or is unavailable. Reload the menu." }); return; }
    items.push({ productId: product._id, name: String(product.name), quantity: item.quantity, unitPricePaise, amountPaise: unitPricePaise * item.quantity });
  }
  const totals = billTotals(items.reduce((sum, item) => sum + item.amountPaise, 0));
  if (!Number.isSafeInteger(totals.totalPaise) || totals.subtotalPaise <= 0 || totals.totalPaise > 100_000_000) { response.status(400).json({ message: "The bill total cannot exceed INR 1,000,000." }); return; }
  if (body.expectedSubtotalPaise !== totals.subtotalPaise) { response.status(409).json({ message: "Prices changed. Reload the menu and review the total." }); return; }
  let customer: Record<string, string> | null = null;
  if (body.customer !== undefined && body.customer !== null) {
    if (typeof body.customer !== "object" || Array.isArray(body.customer)) { response.status(400).json({ message: "Invalid customer details." }); return; }
    const input = body.customer as Record<string, unknown>;
    const plain: Record<string, string> = {};
    for (const field of ["mobile", "firstName", "middleName", "lastName"]) {
      if (typeof input[field] !== "string" || input[field].trim().length > 80) { response.status(400).json({ message: "Customer fields must be text of at most 80 characters." }); return; }
      plain[field] = input[field].trim();
    }
    if (!/^\d{10}$/.test(plain.mobile) || !plain.firstName) { response.status(400).json({ message: "Enter a 10-digit mobile number and customer first name." }); return; }
    try { customer = Object.fromEntries(Object.entries(plain).map(([field, value]) => [field, encrypt(value)])); }
    catch { response.status(503).json({ message: "Customer details cannot be saved until secure storage is configured." }); return; }
  }
  const id = new ObjectId();
  const bill = { _id: id, billNumber: `B-${id.toHexString().toUpperCase()}`, ...access, requestId: body.requestId, orderType: body.orderType, tableNumber, items, ...totals, customer, createdBy: request.auth!.id, createdAt: new Date() };
  try { await db.collection("bills").insertOne(bill); }
  catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const saved = await db.collection("bills").findOne({ storeId: access.storeId, requestId: body.requestId });
    if (!saved) throw error;
    response.json({ bill: serializeBill(saved) }); return;
  }
  response.status(201).json({ bill: serializeBill(bill) });
}