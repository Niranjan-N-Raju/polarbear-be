# Polar Bear Backend

Standalone Express 5 API using TypeScript and Mongoose 8. This project is independent of the sibling Next.js and React Native applications.

## Configuration

Use Node.js 20.17 or newer. Set these variables in a local `.env` file or in the process environment:

- `MONGODB_URI`: MongoDB connection URI, including credentials when required.
- `MONGODB_DB`: Database name. To use the existing application database, supply the same value as the current backend.
- `JWT_SECRET`: long random secret used to sign login tokens. Keep it private and use the same value in any service that verifies these tokens.
- `WEB_ORIGINS`: comma-separated browser origins allowed to call the API. Defaults to local Vite origins on ports `3000`-`3005` and `5173`.
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

## Demo data

`npm run seed:demo` previews 18 demo stores and 18 demo users without changing the database. To insert missing demo records into the configured MongoDB database, run:

```sh
npm run seed:demo -- --apply
```

The seed requires an existing active admin account and associates the demo records with it. It is safe to rerun for record creation: existing records are not duplicated or overwritten. With `--apply`, store assignments are randomly refreshed for every existing demo user and each new demo user gets one or two distinct stores. Demo stores use `DEMO001`-`DEMO018` codes; demo users use `demo.user01@example.test`-`demo.user18@example.test` addresses. User passwords are random and stored only as hashes; these demo accounts are intended for testing the admin user list, not for login. The script refuses to write to a non-local MongoDB URI unless `--allow-remote` is also passed, and it never runs when `NODE_ENV=production`.

## API

`GET /api/health` returns `200` with `{"status":"ok","database":"connected"}` when MongoDB is connected, or `503` when disconnected. Startup requires a successful MongoDB connection before accepting HTTP requests.

`POST /api/auth/login` accepts `{ "email": "...", "password": "..." }` and returns the authenticated user and an eight-hour bearer token. The React Native app uses this endpoint.

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