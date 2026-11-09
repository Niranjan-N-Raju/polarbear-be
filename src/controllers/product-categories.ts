import type { Request, Response } from "express";
import mongoose from "mongoose";
import { ProductCategory } from "../models/ProductCategory.js";
import { isDuplicateKeyError, normalizeProductName } from "../services/franchise-inventory.js";
import { bodyRecord } from "../utils/franchiseRoute.js";

function serializeCategory(category: {
  _id: unknown;
  name: string;
  normalizedName: string;
  createdAt?: Date;
}) {
  return {
    _id: String(category._id),
    name: category.name,
    normalizedName: category.normalizedName,
    createdAt: category.createdAt,
  };
}

export async function getProductCategories(
  _request: Request,
  response: Response
) {
  const categories = await ProductCategory.find({}).sort({ name: 1 }).lean();
  response.json({ categories: categories.map(serializeCategory) });
}

export async function postProductCategory(
  request: Request,
  response: Response
) {
  const rawName = bodyRecord(request).name;
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name || name.length > 100) {
    response.status(400).json({
      message: "Enter a category name of 1 to 100 characters.",
    });
    return;
  }
  const normalizedName = normalizeProductName(name);
  try {
    const category = await ProductCategory.create({ name, normalizedName });
    response.status(201).json({ category: serializeCategory(category) });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      response.status(409).json({ message: "That category name already exists." });
      return;
    }
    throw error;
  }
}

export async function patchProductCategory(
  request: Request,
  response: Response
) {
  const body = bodyRecord(request);
  const categoryId = typeof body.categoryId === "string" ? body.categoryId : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (
    !mongoose.isValidObjectId(categoryId) ||
    !name ||
    name.length > 100
  ) {
    response.status(400).json({ message: "A valid category and name are required." });
    return;
  }
  const id = new mongoose.Types.ObjectId(categoryId);
  try {
    const result = await ProductCategory.updateOne(
      { _id: id },
      { $set: { name, normalizedName: normalizeProductName(name) } },
      { runValidators: true }
    );
    if (!result.matchedCount) {
      response.status(404).json({ message: "Category not found." });
      return;
    }
    const category = await ProductCategory.findById(id).lean();
    response.json({ category: category ? serializeCategory(category) : null });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      response.status(409).json({ message: "That category name already exists." });
      return;
    }
    throw error;
  }
}