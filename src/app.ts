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
import { rejectDangerousKeys } from "./middleware/rejectDangerousKeys.js";
import { cors, securityHeaders } from "./middleware/securityHeaders.js";
import { byIp, rateLimitMiddleware, rateLimits } from "./utils/rateLimit.js";

const UPLOAD_PATHS = ["/api/users/:id/documents/:documentType", "/api/stores/logo"];

export const app = express();

app.disable("x-powered-by");
app.set("trust proxy", false);
app.use(securityHeaders);
app.use(cors);
// Per-IP ceiling for every API call, applied before body parsing so floods never reach JSON parsing or the database.
// Health checks are exempt so load-balancer probes are never throttled.
const apiIpLimiter = rateLimitMiddleware("api-ip", rateLimits.apiIp, byIp);
app.use("/api", (request, response, next) => {
  if (request.path === "/health") {
    next();
    return;
  }
  apiIpLimiter(request, response, next);
});
// Only base64 upload endpoints (5 MB documents, 2 MB logos) need large bodies; everything else is capped at 1 MB.
app.use(UPLOAD_PATHS, express.json({ limit: "8mb" }));
app.use(express.json({ limit: "1mb" }));
app.use(rejectDangerousKeys);
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
app.use("/api/me", profileRouter);
app.use("/api", healthRouter);

app.use((_request, response) => {
  response.status(404).json({ message: "Route not found." });
});

const handleError: ErrorRequestHandler = (error, _request, response, _next) => {
  const parserError = error as { type?: unknown; status?: unknown };
  if (parserError.type === "entity.too.large") {
    response.status(413).json({ message: "Request body is too large." });
    return;
  }
  if (parserError.type === "entity.parse.failed" || parserError.type === "encoding.unsupported" || parserError.type === "charset.unsupported") {
    response.status(400).json({ message: "Invalid request body." });
    return;
  }
  if (process.env.NODE_ENV !== "test") {
    console.error("Unhandled request error:", error instanceof Error ? error.name : "unknown");
  }
  response.status(500).json({ message: "Internal server error." });
};

app.use(handleError);