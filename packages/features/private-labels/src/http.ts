import type { IncomingMessage, ServerResponse } from "node:http";
import { bearerToken } from "@osstrace/accounts";
import type { PrivateLabelService } from "./service.ts";
import type { PrivateLabelErrorCode, PrivateLabelResult } from "./types.ts";

/** A `{ label }` body is a few hundred bytes at most; this is generous and still bounded. */
const MAX_BODY_BYTES = 4 * 1024;

const STATUS_FOR_ERROR: Record<PrivateLabelErrorCode, number> = {
  unauthenticated: 401,
  invalid_chain: 400,
  invalid_address: 400,
  invalid_label: 400,
  not_found: 404,
  limit_reached: 409,
};

export interface PrivateLabelsHttpOptions {
  /**
   * Exact origins allowed to call this API from a browser (CORS). Never `*`: every response is
   * someone's private data. Defaults to the local web UI (`http://localhost:5301`).
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
 * Builds a request handler for the `/private-labels*` routes. Returns `true` if it handled the
 * request, `false` otherwise — same mountable shape as `createAccountsHandler`.
 *
 * The owner of every operation is the user behind the `Authorization: Bearer` token, full stop.
 * No route, query parameter, header or body field selects a different user; extra fields (e.g. a
 * `userId` in the body) are ignored, not honoured.
 *
 * Routes (all JSON; errors are `{ "error": <code>, "message": "..." }`):
 *   GET    /private-labels                    (Bearer)          → 200 { labels }
 *   GET    /private-labels/:chain/:address    (Bearer)          → 200 { label }   (label: null if none)
 *   PUT    /private-labels/:chain/:address    (Bearer) { label } → 201 { label, created: true } | 200 { label, created: false }
 *   DELETE /private-labels/:chain/:address    (Bearer)          → 204, or 404 if you had none
 */
export function createPrivateLabelsHandler(
  service: PrivateLabelService,
  options: PrivateLabelsHttpOptions = {},
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
      headers["access-control-allow-methods"] = "GET, PUT, DELETE, OPTIONS";
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

  function sendResult<T extends object>(
    req: IncomingMessage,
    res: ServerResponse,
    result: PrivateLabelResult<T>,
    okStatus = 200,
  ): void {
    if (!result.ok) {
      send(req, res, STATUS_FOR_ERROR[result.error], { error: result.error, message: result.message });
      return;
    }
    const { ok: _ok, ...body } = result;
    send(req, res, okStatus, body);
  }

  return async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (path !== "/private-labels" && !path.startsWith("/private-labels/")) return false;

    if (req.method === "OPTIONS") {
      send(req, res, 204);
      return true;
    }

    try {
      const token = bearerToken(req);

      if (path === "/private-labels" || path === "/private-labels/") {
        if (req.method === "GET") {
          sendResult(req, res, await service.list(token));
          return true;
        }
        send(req, res, 405, { error: "method_not_allowed", message: "method not allowed on this route" });
        return true;
      }

      const match = path.match(/^\/private-labels\/([^/]+)\/([^/]+)$/);
      if (!match?.[1] || !match[2]) {
        // The request path is never echoed back: responses carry nothing but the caller's own data.
        send(req, res, 404, { error: "not_found", message: "no such route" });
        return true;
      }
      const chain = decodeSegment(match[1]);
      const address = decodeSegment(match[2]);

      if (req.method === "GET") {
        sendResult(req, res, await service.get(token, chain, address));
        return true;
      }
      if (req.method === "PUT") {
        const body = await readJsonBody(req);
        const result = await service.set(token, chain, address, body["label"]);
        sendResult(req, res, result, result.ok && result.created ? 201 : 200);
        return true;
      }
      if (req.method === "DELETE") {
        const result = await service.remove(token, chain, address);
        if (result.ok) send(req, res, 204);
        else sendResult(req, res, result);
        return true;
      }
      send(req, res, 405, { error: "method_not_allowed", message: "method not allowed on this route" });
      return true;
    } catch (cause) {
      if (cause instanceof BodyError) {
        send(req, res, cause.status, { error: "bad_request", message: cause.message });
        return true;
      }
      // Never echo internal details (file paths, other users' data in a stack trace) to the client.
      console.error("private-labels: unhandled error", cause);
      send(req, res, 500, { error: "internal", message: "internal error" });
      return true;
    }
  };
}
