// Request and response shapes the api/*.ts handlers use. scripts/dev-server.ts provides them.
import type { IncomingMessage, ServerResponse } from 'node:http';

export type ApiRequest = IncomingMessage & { query: Record<string, string | string[]>; body: any };
export type ApiResponse = ServerResponse & {
  status(code: number): ApiResponse;
  json(body: unknown): ApiResponse;
  send(body: unknown): ApiResponse;
};
