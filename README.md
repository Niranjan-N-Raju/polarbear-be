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
npm run typecheck
npm run build
npm start
```

Run commands from this project's root. `npm run dev` reloads TypeScript changes; `npm start` runs the compiled output after a build.

## API

`GET /api/health` returns `200` with `{"status":"ok","database":"connected"}` when MongoDB is connected, or `503` when disconnected. Startup requires a successful MongoDB connection before accepting HTTP requests.

`POST /api/auth/login` accepts `{ "email": "...", "password": "..." }` and returns the authenticated user and an eight-hour bearer token. The React Native app uses this endpoint.

Add API routers under `src/routes` and mount them in `src/app.ts`. Keep authentication, database access, secrets, and privileged business operations on this server. Existing Next.js endpoints have not been migrated.

The server binds to `0.0.0.0` for local device access. A physical React Native device must use the development machine's LAN address, not `localhost`. The Android emulator commonly uses `10.0.2.2`. Native transport settings may need development-only HTTP configuration; production must use HTTPS.

No permissive CORS policy or authentication endpoints are included. Configure explicit allowed browser origins and authentication before migrating protected application APIs. MongoDB automatic index creation is disabled to avoid changing an existing database during startup.