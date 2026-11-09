import { Router } from "express";
import {
  getProductCategories,
  patchProductCategory,
  postProductCategory,
} from "../controllers/product-categories.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const productCategoriesRouter = Router();
productCategoriesRouter.use(requireAuth, requireRole("admin"));
productCategoriesRouter.get("/product-categories", getProductCategories);
productCategoriesRouter.post("/product-categories", postProductCategory);
productCategoriesRouter.patch("/product-categories", patchProductCategory);