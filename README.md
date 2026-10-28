# Polar Bear Backend

Standalone Express 5 API using TypeScript and Mongoose 8. This project is independent of the sibling Next.js and React Native applications.

## Configuration

Use Node.js 20.17 or newer. Set these variables in a local `.env` file or in the process environment:

- `MONGODB_URI`: MongoDB connection URI, including credentials when required.
- `MONGODB_DB`: Database name. To use the existing application database, supply the same value as the current backend.
- `JWT_SECRET`: long random secret used to sign login tokens. Keep it private and use the same value in any service that verifies these tokens.
- `WEB_ORIGINS`: optional comma-separated browser origins allowed to call the API. Defaults to local Vite origins on ports `3000`-`3005` and `5173` in development; production allows no cross-origin browser clients unless configured. Native Android/iOS clients do not need this variable.
- `PORT`: HTTP port, default `4000`.

`.env.example` contains local development placeholders, not a production connection. `.env` files are ignored. Never put MongoDB credentials in the mobile app or commit them.

## Commands

```sh
npm install
npm run dev
npm test
npm run typecheck
npm run build
npm start
```

Run commands from this project's root. `npm test` runs the backend unit tests with Node's built-in test runner; tests do not require a database. `npm run dev` reloads TypeScript changes; `npm start` runs the compiled output after a build.

### Dashboard module boundaries

- `src/routes/franchise-dashboard.ts` handles dashboard/store HTTP routing and
  authorization, composing the separate `franchise-sales.ts` router for existing
  sales endpoints. `admin-dashboard.ts` retains administrator access checks.
- `src/services/dashboard.ts` owns dashboard queries and response composition;
  `src/services/sales.ts` owns the bounded sales-list query. Services accept
  already-authorized store IDs; do not expose them directly without route-level
  authorization.
- `src/utils/dashboardInsights.ts` contains pure chart calculations.
  `src/utils/saleTotals.ts` provides shared derived totals for sale reads and
  writes, preserving stored legacy totals when present.

API paths, response shapes, validation, auditing, and rate limits are unchanged.

### Vercel entry point

`src/app.ts` exports the Express application as both a default export for
Vercel and a named export for the local server. The default entry point serves
`/api/greet` without starting a port listener or connecting to MongoDB.
On Vercel (`VERCEL=1`), API requests other than `/api/greet` initialize MongoDB
before routing. Concurrent requests share the connection attempt; warm requests
reuse the connection, and failed attempts can be retried on later requests.
Initialization failures return HTTP 503; `/api/health` reports
`"database":"disconnected"`. Local `npm run dev` and `npm start` still require
a successful database connection before listening.

Set `MONGODB_URI`, `MONGODB_DB`, and `JWT_SECRET` (at least 32 characters) in Vercel's
environment settings and redeploy. Use the existing encryption key for existing
encrypted data. Ensure the MongoDB host permits connections from the deployment.
Do not commit these secrets.

Set `FIELD_ENCRYPTION_KEY` to a 64-character hexadecimal key in the ignored local
backend `.env` and Vercel environment settings. Use the same key when both
environments access the same database. Production requires it at startup;
sensitive field writes require it in every environment and never fall back to
plaintext. Existing encrypted records require their original key.
Existing plaintext records are not automatically encrypted: use the
`migrate:encrypt-pii` command after reviewing its dry run and backing up the data.
Keep a secure backup of the key; losing it prevents decryption.

If initialization returns 503, check Vercel runtime logs:
`[database] Configuration invalid:` identifies the failed environment requirement
without showing its value. `[database] connection failed.` means configuration
validation passed; check MongoDB credentials, network access, DNS, and TLS.
Raw database error messages and connection strings are not logged.

For browser clients, `WEB_ORIGINS` must include the exact frontend origin
(scheme, host, and port), for example `http://localhost:5173`, with multiple
origins separated by commas. Leave it unset or empty for a native-only deployment;
native iOS/Android requests do not require CORS.
CORS is already handled by the API; do not enable wildcard origins.

## Demo data

`npm run seed:demo` previews 18 demo stores and 18 demo users without changing the database. To insert missing demo records into the configured MongoDB database, run:

```sh
npm run seed:demo -- --apply
```

The seed requires an existing active admin account and associates the demo records with it. It is safe to rerun for record creation: existing records are not duplicated or overwritten. With `--apply`, store assignments are randomly refreshed for every existing demo user and each new demo user gets one or two distinct stores. Demo stores use `DEMO001`-`DEMO018` codes; demo users use `demo.user01@example.test`-`demo.user18@example.test` addresses. User passwords are random and stored only as hashes; these demo accounts are intended for testing the admin user list, not for login. The script refuses to write to a non-local MongoDB URI unless `--allow-remote` is also passed, and it never runs when `NODE_ENV=production`.

## API

`GET /api/greet` is public and returns `200` with
`{"message":"Hello! Welcome to Vajan PB."}`. No bearer token or login is required.
It does not query MongoDB, and the existing API rate limit still applies.
For local testing with the backend running:

```sh
curl http://localhost:4000/api/greet
```

`GET /api/health` returns `200` with `{"status":"ok","database":"connected"}` when MongoDB is connected, or `503` when disconnected. Startup requires a successful MongoDB connection before accepting HTTP requests.

`POST /api/auth/login` accepts `{ "email": "...", "password": "..." }` and returns the authenticated user and an eight-hour bearer token. The React Native app uses this endpoint.

`POST /api/auth/logout` requires a bearer token and increments the user's session version before returning success. This invalidates all existing sessions for that account, including extended tokens, across devices. A database failure returns an error rather than claiming revocation succeeded.

### Authentication and authorization contract

Tokens use HS256, issuer `polar-bear-backend`, audience `polar-bear-api`, and an
eight-hour lifetime. Verification requires `exp`, `iat`, a valid MongoDB user
`id`, and a nonnegative integer `sessionVersion`; tokens older than eight hours
or issued in the future are rejected. Deploying this contract requires users
with older tokens (including legacy Next.js tokens) to sign in again.

Every authenticated request reloads the current account. Deleted/inactive
accounts and mismatched session versions are rejected; the database role, not
the signed role or client headers, determines permissions. Password changes
require the current password, increment the session version, and return a new
token. `/api/auth/extend` renews an authenticated session without rotating or
invalidating its other access tokens. Sessions have a 24-hour absolute cap via
the required `sessionStart` claim; extension never moves it and returns 401
once the cap is reached. There is no refresh-token family or password-reset
endpoint. Store access comes only from explicit `franchises` assignments,
archived stores are read-only for store users, and administrators cannot
modify or delete other administrators.

The actual roles are `admin`, `sub_admin`, `franchise_admin`, and `employee`.
All four can use their own `/api/me` and authenticated session endpoints.
`admin` has global administrative reads and user management, with store
mutations restricted to stores created by that admin. `franchise_admin` has
operational access only to assigned or owned stores, checked on each request.
There is no separate outlet-manager role or tenant-ID authorization mechanism;
outlet isolation uses store/franchise IDs. `sub_admin` and `employee` currently
have no operational-route access. Preserve these boundaries when adding routes.

Use a dedicated signing secret for this API. Any other service holding the same
symmetric key can mint matching issuer/audience claims; those claims are not
isolation from another holder of the key. Mobile clients call logout before
clearing local state; an offline/error fallback clears only local state and logs
a warning, so server revocation is not guaranteed in that case.

`tests/authorizationAudit.test.ts` exercises the explicit protected-route matrix,
JWT/account checks, privilege escalation, and resource-level store predicates
using real local HTTP requests and mocked database operations. Run it with
`npx tsx --test tests/authorizationAudit.test.ts`. It does not substitute for
integration testing against an isolated MongoDB deployment.

The product catalog is global. Only platform `admin` accounts may create, rename,
or delete products using `/api/products`; these operations do not require a store
ID. Franchise admins can read the catalog with an authorized `storeId` and manage
their own stock, but catalog mutations return `403`.

### Franchise-admin dashboard

Franchise admins can use these bearer-authenticated endpoints:

- `GET /api/stores`: all stores assigned to or created by the authenticated user, sorted by name. Returns only selection fields, not owner contact information.
- `GET /api/dashboard?storeId=<id>`: selected-store employee count, current-calendar-month sales, six-month attrition, all-history weekday averages, top eight expense categories, and payment mix for the last six recorded sales months. `storeCount` is the number of accessible stores.
- `GET /api/sales?storeId=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD`: daily sales totals for the inclusive range, limited to 366 days between endpoints.

Unlike Next.js's active-store cookie, mobile requests explicitly supply `storeId`; both data endpoints recheck current assignment/ownership on every request. A missing/invalid ID returns `400`; an inaccessible or removed store returns `403`, never an all-stores fallback. Store selection is session-local client state, not a database mutation. The client auto-selects a single store and requires selection when multiple stores are available.

Attendance summary remains `0`, matching the not-yet-defined aggregation in Next.js. Sales and employee history use the existing `sales` and `users` collections; no data is seeded or rewritten by this migration. Admin endpoints retain their existing behavior. Other franchise operational screens/APIs are not yet migrated.

Add API routers under `src/routes` and mount them in `src/app.ts`. Keep authentication, database access, secrets, and privileged business operations on this server.

The server binds to `0.0.0.0` for local device access. A physical React Native device must use the development machine's LAN address, not `localhost`. The Android emulator commonly uses `10.0.2.2`. Native transport settings may need development-only HTTP configuration; production must use HTTPS.

Configure explicit allowed browser origins when using the API from the web. MongoDB automatic index creation is disabled to avoid changing an existing database during startup.