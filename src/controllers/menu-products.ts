import type { Request, Response } from "express";
import mongoose from "mongoose";
import { Product } from "../models/Inventory.js";
import { MenuProduct, type CompositionItem } from "../models/MenuProduct.js";
import { ProductCategory } from "../models/ProductCategory.js";
import { isDuplicateKeyError, normalizeProductName } from "../services/franchise-inventory.js";
import { bodyRecord } from "../utils/franchiseRoute.js";

function parseComposition(value: unknown): CompositionItem[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 100) return null;
  const items: CompositionItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { productId, quantity } = entry as Record<string, unknown>;
    if (typeof productId !== "string" || !mongoose.isValidObjectId(productId) ||
        typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) return null;
    items.push({ productId: new mongoose.Types.ObjectId(productId), quantity });
  }
  return new Set(items.map((item) => String(item.productId))).size === items.length ? items : null;
}

export async function getMenuProducts(_request: Request, response: Response) {
  const products = await MenuProduct.find({}).sort({ name: 1 }).lean();
  response.json({ products });
}

export async function saveMenuProduct(request: Request, response: Response) {
  const body = bodyRecord(request);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const price = body.price;
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0.01 || price > 1_000_000 || Math.abs(price * 100 - Math.round(price * 100)) > 0.000001) {
    response.status(400).json({ message: "Enter a price between 0.01 and 1,000,000 rupees, with at most two decimal places." });
    return;
  }
  const categoryId = typeof body.categoryId === "string" ? body.categoryId : "";
  const dineIn = parseComposition(body.dineIn);
  const takeAway = parseComposition(body.takeAway);
  const editing = request.method === "PATCH";
  const productId = typeof body.productId === "string" ? body.productId : "";
  if (!name || name.length > 100 || !mongoose.isValidObjectId(categoryId) ||
      !dineIn || !takeAway || (editing && !mongoose.isValidObjectId(productId))) {
    response.status(400).json({ message: "A category, product name (1 to 100 characters), and both compositions with unique materials and positive quantities are required." });
    return;
  }
  if (!await ProductCategory.exists({ _id: new mongoose.Types.ObjectId(categoryId) })) {
    response.status(400).json({ message: "Choose an existing category." });
    return;
  }
  const materialIds = [...new Set([...dineIn, ...takeAway].map((item) => String(item.productId)))];
  const count = await Product.countDocuments({ _id: { $in: materialIds.map((id) => new mongoose.Types.ObjectId(id)) } });
  if (count !== materialIds.length) {
    response.status(400).json({ message: "Choose existing raw materials for both compositions." });
    return;
  }
  const normalizedName = normalizeProductName(name);
  const id = editing ? new mongoose.Types.ObjectId(productId) : null;
  if (await MenuProduct.exists({ normalizedName, ...(id ? { _id: { $ne: id } } : {}) })) {
    response.status(409).json({ message: "That product name already exists." });
    return;
  }
  const values = { name, normalizedName, price: Math.round(price * 100) / 100, categoryId: new mongoose.Types.ObjectId(categoryId), dineIn, takeAway };
  try {
    const product = id
      ? await MenuProduct.findOneAndUpdate({ _id: id }, { $set: values }, { new: true, runValidators: true })
      : await MenuProduct.create(values);
    if (!product) {
      response.status(404).json({ message: "Product not found." });
      return;
    }
    response.status(editing ? 200 : 201).json({ product });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      response.status(409).json({ message: "That product name already exists." });
      return;
    }
    throw error;
  }
}