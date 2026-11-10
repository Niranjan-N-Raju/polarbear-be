import { Router } from "express";
import { getMenuProducts, saveMenuProduct } from "../controllers/menu-products.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const menuProductsRouter = Router();
menuProductsRouter.use(requireAuth, requireRole("admin"));
menuProductsRouter.get("/menu-products", getMenuProducts);
menuProductsRouter.post("/menu-products", saveMenuProduct);
menuProductsRouter.patch("/menu-products", saveMenuProduct);