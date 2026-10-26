import type { Server } from "node:http";

export const SERVER_TIMEOUTS = {
  // Slowloris protection: clients must finish sending headers / the whole request promptly.
  headersTimeoutMs: 20_000,
  requestTimeoutMs: 30_000,
  keepAliveTimeoutMs: 5_000,
  maxRequestsPerSocket: 1_000,
} as const;

export function configureServerTimeouts(server: Server): Server {
  server.headersTimeout = SERVER_TIMEOUTS.headersTimeoutMs;
  server.requestTimeout = SERVER_TIMEOUTS.requestTimeoutMs;
  server.keepAliveTimeout = SERVER_TIMEOUTS.keepAliveTimeoutMs;
  server.maxRequestsPerSocket = SERVER_TIMEOUTS.maxRequestsPerSocket;
  return server;
}
