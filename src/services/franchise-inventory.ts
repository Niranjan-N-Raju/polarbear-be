import { MAX_STOCK_QUANTITY } from '../utils/businessLimits.js';
export const MAX_PRODUCTS_PER_REQUEST = 100;
export function normalizeProductName(value: string) {
  return value.trim().toLowerCase();
}
export function parsePositiveInteger(value: unknown) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value <= MAX_STOCK_QUANTITY ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return parsed > 0 && parsed <= MAX_STOCK_QUANTITY ? parsed : null;
  }
  return null;
}
export function isDuplicateKeyError(error: unknown) {
  return (error as { code?: number; } | null)?.code === 11000;
}
export function serializeProduct(product: { _id: unknown; name: string; normalizedName: string; createdAt?: Date; }) {
  return {
    _id: String(product._id),
    name: product.name,
    normalizedName: product.normalizedName,
    createdAt: product.createdAt,
  };
}
export function serializeItem(item: { _id: unknown; productId: unknown; product: string; quantity: number; expiryDate: string; }) {
  return {
    _id: String(item._id),
    productId: String(item.productId),
    product: item.product,
    quantity: item.quantity,
    expiryDate: item.expiryDate,
  };
}
