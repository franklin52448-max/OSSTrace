import type { Chain } from "@osstrace/contract";
import type { FastifyRequest } from "fastify";
import type { ChainProvider } from "./chain/types.ts";
import type { PriceService } from "./chain/prices.ts";
import type { TransferStore } from "./chain/store.ts";
import type { SyncService } from "./chain/sync.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db/index.ts";
import type { Resolver } from "./lib/ssrf.ts";
import type { SessionUser } from "./auth/sessions.ts";
import { unauthorized } from "./lib/errors.ts";

export type WebhookSender = (url: string, body: string, headers: Record<string, string>) => Promise<{ ok: boolean; status: number | null; detail: string }>;

export type Ctx = {
  config: Config;
  db: Db;
  providers: Record<Chain, ChainProvider>;
  prices: PriceService;
  store: TransferStore;
  sync: SyncService;
  resolver: Resolver;
  sendWebhook: WebhookSender;
  version: string;
  fetchImpl: typeof fetch;
};

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
