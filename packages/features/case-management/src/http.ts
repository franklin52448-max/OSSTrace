import type { IncomingMessage, ServerResponse } from "node:http";
import { bearerToken } from "@osstrace/accounts";
import type { CaseService } from "./service.ts";
import type { CaseErrorCode, CaseResult } from "./types.ts";

/** An 8,000-character description is at most ~32 KiB of UTF-8; this is generous and still bounded. */
const MAX_BODY_BYTES = 64 * 1024;

const STATUS_FOR_ERROR: Record<CaseErrorCode, number> = {
  unauthenticated: 401,
  invalid_case: 400,
  invalid_item: 400,
  invalid_chain: 400,
  invalid_address: 400,
  not_found: 404,
  case_closed: 409,
  case_not_closed: 409,
  duplicate_item: 409,
  limit_reached: 409,
};

export interface CasesHttpOptions {
  /**
   * Exact origins allowed to call this API from a browser (CORS). Never `*`: every response is
   * someone's private investigation. Defaults to the local web UI (`http://localhost:5301`).
   */
  allowedOrigins?: readonly string[];
}

class BodyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
  } catch {
    throw new BodyError(400, "request body must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BodyError(400, "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new BodyError(400, "malformed URL encoding in path");
  }
}

/**
 * Request handler for the `/cases` routes. Returns `false` for any other path, so it can be
 * mounted inside another server, same as `createAccountsHandler` / `createBountiesHandler`.
 *
 * The owner of every operation is the user behind the `Authorization: Bearer` token, full stop
 * (ADR 0011). No route, query parameter, header or body field selects a different user; extra
 * fields (an `ownedBy` in the body, a `?userId=`) are ignored. Someone else's case id gets the same
 * `404` as an id that doesn't exist.
 *
 *   GET    /cases?status=open|closed            (Bearer)                    → 200 { cases }
 *   POST   /cases                               (Bearer) { title, description? } → 201 { case }
 *   GET    /cases/:id                           (Bearer)                    → 200 { case, items }
 *   PATCH  /cases/:id                           (Bearer) { title?, description? } → 200 { case }
 *   DELETE /cases/:id                           (Bearer)                    → 204
 *   POST   /cases/:id/close                     (Bearer)                    → 200 { case }
 *   POST   /cases/:id/reopen                    (Bearer)                    → 200 { case }
 *   POST   /cases/:id/items                     (Bearer) { chain, address, note? } → 201 { item }
 *   PATCH  /cases/:id/items/:itemId             (Bearer) { note }           → 200 { item }
 *   DELETE /cases/:id/items/:itemId             (Bearer)                    → 204
 *
 * Errors are `{ "error": <CaseErrorCode | "bad_request" | "method_not_allowed">, "message": "..." }`.
 * Error messages never echo the request path or any input back.
 */
export function createCasesHandler(
  service: CaseService,
  options: CasesHttpOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const allowedOrigins = new Set(options.allowedOrigins ?? ["http://localhost:5301"]);

  function baseHeaders(req: IncomingMessage): Record<string, string> {
    const headers: Record<string, string> = {
      // Private, per-user data: never cached by a browser or a shared proxy...
      "cache-control": "no-store, private",
      // ...and if anything caches it anyway, it must key on who asked.
      vary: "Origin, Authorization",
    };
    const origin = req.headers["origin"];
    if (typeof origin === "string" && allowedOrigins.has(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers["access-control-allow-headers"] = "authorization, content-type";
      headers["access-control-allow-methods"] = "GET, POST, PATCH, DELETE, OPTIONS";
    }
    return headers;
  }

  function send(req: IncomingMessage, res: ServerResponse, status: number, body?: unknown): void {
    const headers = baseHeaders(req);
    if (body === undefined) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    res.writeHead(status, { ...headers, "content-type": "application/json" });
    res.end(JSON.stringify(body, null, 2));
  }

  function sendResult<T extends object>(req: IncomingMessage, res: ServerResponse, result: CaseResult<T>, okStatus = 200): void {
    if (!result.ok) {
      send(req, res, STATUS_FOR_ERROR[result.error], { error: result.error, message: result.message });
      return;
    }
    if (okStatus === 204) {
      send(req, res, 204);
      return;
    }
    const { ok: _ok, ...body } = result;
    send(req, res, okStatus, body);
  }

  const methodNotAllowed = (req: IncomingMessage, res: ServerResponse): void =>
    send(req, res, 405, { error: "method_not_allowed", message: "method not allowed on this route" });

  return async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (path !== "/cases" && !path.startsWith("/cases/")) return false;

    if (req.method === "OPTIONS") {
      send(req, res, 204);
      return true;
    }

    try {
      const token = bearerToken(req);

      if (path === "/cases" || path === "/cases/") {
        if (req.method === "GET") sendResult(req, res, await service.list(token, url.searchParams.get("status") ?? undefined));
        else if (req.method === "POST") sendResult(req, res, await service.create(token, await readJsonBody(req)), 201);
        else methodNotAllowed(req, res);
        return true;
      }

      const item = path.match(/^\/cases\/([^/]+)\/items\/([^/]+)$/);
      if (item?.[1] && item[2]) {
        const caseId = decodeSegment(item[1]);
        const itemId = decodeSegment(item[2]);
        if (req.method === "PATCH") sendResult(req, res, await service.updateItem(token, caseId, itemId, await readJsonBody(req)));
        else if (req.method === "DELETE") sendResult(req, res, await service.removeItem(token, caseId, itemId), 204);
        else methodNotAllowed(req, res);
        return true;
      }

      const items = path.match(/^\/cases\/([^/]+)\/items$/);
      if (items?.[1]) {
        if (req.method === "POST") sendResult(req, res, await service.addItem(token, decodeSegment(items[1]), await readJsonBody(req)), 201);
        else methodNotAllowed(req, res);
        return true;
      }

      const action = path.match(/^\/cases\/([^/]+)\/(close|reopen)$/);
      if (action?.[1]) {
        const caseId = decodeSegment(action[1]);
        if (req.method !== "POST") methodNotAllowed(req, res);
        else if (action[2] === "close") sendResult(req, res, await service.close(token, caseId));
        else sendResult(req, res, await service.reopen(token, caseId));
        return true;
      }

      const detail = path.match(/^\/cases\/([^/]+)$/);
      if (detail?.[1]) {
        const caseId = decodeSegment(detail[1]);
        if (req.method === "GET") sendResult(req, res, await service.get(token, caseId));
        else if (req.method === "PATCH") sendResult(req, res, await service.update(token, caseId, await readJsonBody(req)));
        else if (req.method === "DELETE") sendResult(req, res, await service.remove(token, caseId), 204);
        else methodNotAllowed(req, res);
        return true;
      }

      // The request path is never echoed back: responses carry nothing but the caller's own data.
      send(req, res, 404, { error: "not_found", message: "no such route" });
      return true;
    } catch (cause) {
      if (cause instanceof BodyError) {
        send(req, res, cause.status, { error: "bad_request", message: cause.message });
        return true;
      }
      // Never echo internal details (file paths, other users' data in a stack trace) to the client.
      console.error("case-management: unhandled error", cause);
      send(req, res, 500, { error: "internal", message: "internal error" });
      return true;
    }
  };
}
