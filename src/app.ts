import express from "express";
import type { ErrorRequestHandler } from "express";
import { authRouter } from "./routes/auth.js";
import { adminDashboardRouter } from "./routes/admin-dashboard.js";
import { adminStoresRouter } from "./routes/admin-stores.js";
import { adminUsersRouter } from "./routes/admin-users.js";
import { franchiseDashboardRouter } from "./routes/franchise-dashboard.js";
import { franchiseInventoryRouter } from "./routes/franchise-inventory.js";
import { franchiseWithdrawalsRouter } from "./routes/franchise-withdrawals.js";
import { franchisePnlRouter } from "./routes/franchise-pnl.js";
import { franchiseStoreConfigRouter } from "./routes/franchise-store-config.js";
import { franchiseEmployeesRouter } from "./routes/franchise-employees.js";
import { franchiseAttendanceRouter } from "./routes/franchise-attendance.js";
import { franchiseSalaryRouter } from "./routes/franchise-salary.js";
import { healthRouter } from "./routes/health.js";
import { profileRouter } from "./routes/profile.js";

export const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "8mb" }));
app.use((request, response, next) => {
  const origin = request.header("origin");
  const allowedOrigins = (
    process.env.WEB_ORIGINS ??
    "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001,http://localhost:3002,http://127.0.0.1:3002,http://localhost:3003,http://127.0.0.1:3003,http://localhost:3004,http://127.0.0.1:3004,http://localhost:3005,http://127.0.0.1:3005,http://localhost:5173,http://127.0.0.1:5173"
  )
    .split(",")
    .map((value) => value.trim());

  if (origin && allowedOrigins.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }

  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }

  next();
});
app.use("/api/auth", authRouter);
app.use("/api", franchiseDashboardRouter);
app.use("/api", franchiseInventoryRouter);
app.use("/api", franchiseWithdrawalsRouter);
app.use("/api", franchisePnlRouter);
app.use("/api", franchiseStoreConfigRouter);
app.use("/api", franchiseEmployeesRouter);
app.use("/api", franchiseAttendanceRouter);
app.use("/api", franchiseSalaryRouter);
app.use("/api", adminDashboardRouter);
app.use("/api", adminStoresRouter);
app.use("/api", adminUsersRouter);
app.use("/api", adminUsersRouter);
app.use("/api/me", profileRouter);
app.use("/api/me", profileRouter);
app.use("/api", healthRouter);

app.use((_request, response) => {
  response.status(404).json({ message: "Route not found." });
});

const handleError: ErrorRequestHandler = (_error, _request, response, _next) => {
  response.status(500).json({ message: "Internal server error." });
};

app.use(handleError);