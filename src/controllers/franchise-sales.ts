import type { NextFunction,Request,Response } from 'express';
import mongoose from 'mongoose';
import { Sale } from '../models/Sale.js';
import { dateRange,isDuplicateKeyError,parseSaleRequest,saleAuditSnapshot } from '../services/franchise-sales.js';
import { getStoreSales } from '../services/sales.js';
import { auditMutation } from '../utils/businessLimits.js';
import { authorizeStore } from '../utils/storeAccess.js';
export async function getSales(request: Request, response: Response, next: NextFunction) {
  if (request.auth?.role !== 'franchise_admin') {
    next();
    return;
  }
  const storeObjectId = await authorizeStore(request.query.storeId, request.auth.id, response);
  if (!storeObjectId) return;
  const range = dateRange(request, response);
  if (!range) return;

  response.json({ sales: await getStoreSales(storeObjectId, range) });
}

export async function postSales(request: Request, response: Response, next: NextFunction) {
  if (request.auth?.role !== 'franchise_admin') {
    next();
    return;
  }
  const parsed = await parseSaleRequest(request, response);
  if (!parsed) return;
  if (await Sale.findOne({ franchise: parsed.storeObjectId, date: parsed.values.date }).select('_id').lean()) {
    response.status(409).json({ message: 'A sale already exists for this date.' });
    return;
  }
  try {
    const sale = await Sale.create({
      ...parsed.values,
      franchise: parsed.storeObjectId,
      createdBy: new mongoose.Types.ObjectId(request.auth.id),
    });
    auditMutation(request, 'sale.created', { storeId: parsed.storeObjectId, targetId: sale._id, after: parsed.values });
    response.status(201).json({ sale, message: 'Sale saved successfully.' });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      response.status(409).json({ message: 'A sale already exists for this date.' });
      return;
    }
    throw error;
  }
}

export async function putSalesId(request: Request, response: Response, next: NextFunction) {
  if (request.auth?.role !== 'franchise_admin') {
    next();
    return;
  }
  const saleId = request.params.id;
  if (typeof saleId !== 'string' || !mongoose.isValidObjectId(saleId)) {
    response.status(400).json({ message: 'A valid sale id is required.' });
    return;
  }
  const parsed = await parseSaleRequest(request, response);
  if (!parsed) return;
  const duplicate = await Sale.findOne({
    franchise: parsed.storeObjectId,
    date: parsed.values.date,
    _id: { $ne: new mongoose.Types.ObjectId(saleId) },
  }).select('_id').lean();
  if (duplicate) {
    response.status(409).json({ message: 'A sale already exists for this date.' });
    return;
  }
  try {
    const before = await Sale.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(saleId), franchise: parsed.storeObjectId },
      { $set: parsed.values },
      { new: false, runValidators: true },
    ).lean();
    if (!before) {
      response.status(404).json({ message: 'Sale not found.' });
      return;
    }
    const sale = { ...before, ...parsed.values };
    auditMutation(request, 'sale.updated', {
      storeId: parsed.storeObjectId,
      targetId: before._id,
      before: saleAuditSnapshot(before),
      after: parsed.values,
    });
    response.json({ sale, message: 'Sale updated successfully.' });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      response.status(409).json({ message: 'A sale already exists for this date.' });
      return;
    }
    throw error;
  }
}
