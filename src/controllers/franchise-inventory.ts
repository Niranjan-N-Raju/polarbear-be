import type { NextFunction } from 'express';
import { type Request,type Response } from 'express';
import mongoose from 'mongoose';
import { DumpedInventory,InventoryItem,Product } from '../models/Inventory.js';
import { isDuplicateKeyError,MAX_PRODUCTS_PER_REQUEST,normalizeProductName,parsePositiveInteger,serializeItem,serializeProduct } from '../services/franchise-inventory.js';
import { localDateValue } from '../utils/dateUtils.js';
import { bodyRecord,isFranchiseAdmin,requireStore } from '../utils/franchiseRoute.js';
import { auditMutation } from '../utils/businessLimits.js';
import { isDateValue } from '../utils/storeAccess.js';
export async function getProducts(request: Request, response: Response, next: NextFunction) {
  if (request.auth?.role === 'admin') {
    const products = await Product.find({}).sort({ name: 1 }).lean();
    response.json({ products: products.map(serializeProduct) });
    return;
  }
  if (!isFranchiseAdmin(request)) { next(); return; }
  if (!(await requireStore(request, response))) return;
  const products = await Product.find({}).sort({ name: 1 }).lean();
  response.json({ products: products.map(serializeProduct) });
}

export async function postProducts(request: Request, response: Response) {
  const { name } = bodyRecord(request);
  const names = typeof name === 'string'
    ? name.split(',').map((value) => value.trim()).filter(Boolean)
    : [];
  const normalizedNames = names.map(normalizeProductName);
  if (names.length === 0) {
    response.status(400).json({ message: 'Enter at least one product name.' });
    return;
  }
  if (names.length > MAX_PRODUCTS_PER_REQUEST) {
    response.status(400).json({ message: `Add at most ${MAX_PRODUCTS_PER_REQUEST} products at a time.` });
    return;
  }
  if (names.some((value) => value.length > 100)) {
    response.status(400).json({ message: 'Each product name must be 100 characters or fewer.' });
    return;
  }
  if (new Set(normalizedNames).size !== normalizedNames.length) {
    response.status(409).json({ message: 'Product names must be unique.' });
    return;
  }
  // Pre-check avoids partially inserting a batch when one name already exists.
  const existing = await Product.find({ normalizedName: { $in: normalizedNames } }).select('_id').lean();
  if (existing.length > 0) {
    response.status(409).json({ message: 'A product with this name already exists.' });
    return;
  }
  const products = names.map((value, index) => ({
    _id: new mongoose.Types.ObjectId(),
    name: value,
    normalizedName: normalizedNames[index]!,
    createdAt: new Date(),
  }));
  try {
    await Product.collection.insertMany(products, { ordered: true });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      response.status(409).json({ message: 'A product with this name already exists.' });
      return;
    }
    throw error;
  }
  response.status(201).json({ products: products.map(serializeProduct) });
}

export async function patchProducts(request: Request, response: Response) {
  const body = bodyRecord(request);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const productId = typeof body.productId === 'string' ? body.productId : '';
  if (!mongoose.isValidObjectId(productId) || !name || name.length > 100) {
    response.status(400).json({ message: 'A valid product and name are required.' });
    return;
  }
  const objectId = new mongoose.Types.ObjectId(productId);
  const existing = await Product.findById(objectId).select('_id').lean();
  if (!existing) {
    response.status(404).json({ message: 'Product not found.' });
    return;
  }
  try {
    await Product.updateOne({ _id: objectId }, { $set: { name, normalizedName: normalizeProductName(name) } });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      response.status(409).json({ message: 'A product with this name already exists.' });
      return;
    }
    throw error;
  }
  await InventoryItem.updateMany({ productId: objectId }, { $set: { product: name } });
  response.json({ message: 'Product updated.' });
}

export async function deleteProducts(request: Request, response: Response) {
  const body = bodyRecord(request);
  const productId = typeof body.productId === 'string' ? body.productId : '';
  if (!mongoose.isValidObjectId(productId)) {
    response.status(400).json({ message: 'A valid product is required.' });
    return;
  }
  const objectId = new mongoose.Types.ObjectId(productId);
  const product = await Product.findById(objectId).select('_id').lean();
  if (!product) {
    response.status(404).json({ message: 'Product not found.' });
    return;
  }
  const [inventoryReferences, dumpedReferences] = await Promise.all([
    InventoryItem.countDocuments({ productId: objectId }),
    DumpedInventory.countDocuments({ productId: objectId }),
  ]);
  if (inventoryReferences || dumpedReferences) {
    response.status(409).json({ message: 'This product has stock or disposal history and cannot be deleted.' });
    return;
  }
  await Product.deleteOne({ _id: objectId });
  response.json({ message: 'Product deleted.' });
}

export async function getInventory(request: Request, response: Response, next: NextFunction) {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const store = await requireStore(request, response);
  if (!store) return;
  const items = await InventoryItem.find({ storeId: String(store), quantity: { $gt: 0 } })
    .sort({ expiryDate: 1, product: 1 })
    .lean();
  response.json({ items: items.map(serializeItem) });
}

export async function postInventory(request: Request, response: Response, next: NextFunction) {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const store = await requireStore(request, response);
  if (!store) return;
  const storeId = String(store);
  const body = bodyRecord(request);
  const quantity = parsePositiveInteger(body.quantity);
  const productId = typeof body.productId === 'string' ? body.productId : '';
  if (!mongoose.isValidObjectId(productId) || !isDateValue(body.expiryDate) || !quantity) {
    response.status(400).json({ message: 'Product, expiry date, and a positive quantity are required.' });
    return;
  }
  const product = await Product.findById(productId).lean();
  if (!product) {
    response.status(404).json({ message: 'Choose a predefined product.' });
    return;
  }
  const item = await InventoryItem.findOneAndUpdate(
    { storeId, productId: product._id, expiryDate: body.expiryDate },
    {
      $set: { product: product.name },
      $setOnInsert: { storeId, productId: product._id, expiryDate: body.expiryDate, createdAt: new Date() },
      $inc: { quantity },
    },
    { upsert: true, new: true, lean: true },
  );
  auditMutation(request, 'inventory.stock.added', { storeId, targetId: item?._id, after: { productId, expiryDate: body.expiryDate, quantityAdded: quantity, quantity: item?.quantity } });
  response.status(201).json({ item: item ? serializeItem(item) : null });
}

export async function patchInventory(request: Request, response: Response, next: NextFunction) {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const store = await requireStore(request, response);
  if (!store) return;
  const storeId = String(store);
  const body = bodyRecord(request);
  const itemIdValue = typeof body.inventoryItemId === 'string' ? body.inventoryItemId : '';
  if (!mongoose.isValidObjectId(itemIdValue)) {
    response.status(400).json({ message: 'A valid inventory item is required.' });
    return;
  }
  const itemId = new mongoose.Types.ObjectId(itemIdValue);
  const item = await InventoryItem.findOne({ _id: itemId, storeId, quantity: { $gt: 0 } }).lean();
  if (!item) {
    response.status(404).json({ message: 'Inventory item not found or already empty.' });
    return;
  }
  const today = localDateValue();

  if (body.action === 'consume') {
    const quantity = parsePositiveInteger(body.quantity);
    if (!quantity) {
      response.status(400).json({ message: 'Choose a positive quantity.' });
      return;
    }
    if (item.expiryDate < today) {
      response.status(400).json({ message: 'Expired stock cannot be consumed.' });
      return;
    }
    // First-expiry-first-out: older usable batches must be consumed before newer ones.
    const earlier = await InventoryItem.findOne({
      storeId,
      productId: item.productId,
      expiryDate: { $gte: today, $lt: item.expiryDate },
      quantity: { $gt: 0 },
    }).sort({ expiryDate: 1 }).lean();
    if (earlier) {
      response.status(400).json({ message: `Use the earlier expiry ${earlier.expiryDate} first.` });
      return;
    }
    const updated = await InventoryItem.findOneAndUpdate(
      { _id: itemId, storeId, quantity: { $gte: quantity }, expiryDate: { $gte: today } },
      { $inc: { quantity: -quantity } },
      { new: true, lean: true },
    );
    if (!updated) {
      response.status(400).json({ message: 'Not enough stock available.' });
      return;
    }
    // Re-validate FIFO after the atomic decrement: an earlier batch restocked concurrently
    // between the check above and the update means this consumption must be reverted.
    const racedEarlier = await InventoryItem.findOne({
      storeId,
      productId: item.productId,
      expiryDate: { $gte: today, $lt: item.expiryDate },
      quantity: { $gt: 0 },
    }).sort({ expiryDate: 1 }).lean();
    if (racedEarlier) {
      await InventoryItem.updateOne({ _id: itemId, storeId }, { $inc: { quantity } });
      response.status(409).json({ message: `Use the earlier expiry ${racedEarlier.expiryDate} first.` });
      return;
    }
    auditMutation(request, 'inventory.stock.consumed', { storeId, targetId: itemId, before: { quantity: updated.quantity + quantity }, after: { quantity: updated.quantity, quantityConsumed: quantity } });
    response.json({ message: 'Stock consumed successfully.', item: serializeItem(updated) });
    return;
  }

  if (body.action === 'dump') {
    if (item.expiryDate >= today) {
      response.status(400).json({ message: 'Only expired stock can be dumped.' });
      return;
    }
    // Returning the pre-update document gives the exact quantity this request removed.
    const before = await InventoryItem.findOneAndUpdate(
      { _id: itemId, storeId, quantity: { $gt: 0 }, expiryDate: { $lt: today } },
      { $set: { quantity: 0 } },
      { new: false, lean: true },
    );
    if (!before) {
      response.status(409).json({ message: 'Stock was already dumped.' });
      return;
    }
    await DumpedInventory.create({
      inventoryItemId: itemId,
      storeId,
      productId: before.productId,
      product: before.product,
      expiryDate: before.expiryDate,
      quantity: before.quantity,
      dumpedAt: new Date(),
    });
    auditMutation(request, 'inventory.stock.dumped', { storeId, targetId: itemId, before: { quantity: before.quantity, expiryDate: before.expiryDate }, after: { quantity: 0 } });
    response.json({ message: 'Expired stock dumped successfully.' });
    return;
  }

  response.status(400).json({ message: 'Unsupported inventory action.' });
}
