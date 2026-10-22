import type { IncomingMessage, ServerResponse } from "node:http";
import { bearerToken } from "@osstrace/accounts";
import type { BountyService } from "./service.ts";
import type { BountyErrorCode, BountyResult } from "./types.ts";

/** Generous for a real in-depth spec; small enough nobody can stream megabytes at us. */
const MAX_BODY_BYTES = 64 * 1024;

const STATUS_FOR_ERROR: Record<BountyErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  invalid_bounty: 400,
  invalid_submission: 400,
  not_found: 404,
  not_open: 409,
  already_resolved: 409,
};

export interface BountiesHttpOptions {
  /** Exact browser origins allowed (CORS). Never `*`: requests carry session tokens. */
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

/**
 * Request handler for the `/bounties` routes. Returns `false` for any other path, so it can be
 * mounted inside another server, same as `createAccountsHandler`/`createLabelSubmissionsHandler`.
 *
 *   POST /bounties                          (Bearer)             body → 201 { bounty }
 *   GET  /bounties?status=…                 (public)                  → 200 { bounties }
 *   GET  /bounties/:id                      (public)                  → 200 { bounty }
 *   GET  /bounties/:id/submissions          (public)                  → 200 { submissions }
 *   POST /bounties/:id/submissions          (Bearer)             body → 201 { submission }
 *   POST /bounties/:id/claim                (Bearer, moderator)  { submissionId } → 200 { bounty }
 *   POST /bounties/:id/cancel               (Bearer, opener|moderator) { reason } → 200 { bounty }
 *
 * Errors are `{ "error": <BountyErrorCode or "bad_request">, "message": "..." }`.
 */
export function createBountiesHandler(
  service: BountyService,
  options: BountiesHttpOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const allowedOrigins = new Set(options.allowedOrigins ?? ["http://localhost:5301"]);

  function send(req: IncomingMessage, res: ServerResponse, status: number, body?: unknown): void {
    const headers: Record<string, string> = { "cache-control": "no-store", vary: "Origin" };
    const origin = req.headers["origin"];
    if (typeof origin === "string" && allowedOrigins.has(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers["access-control-allow-headers"] = "authorization, content-type";
      headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
    }
    if (body === undefined) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    res.writeHead(status, { ...headers, "content-type": "application/json" });
    res.end(JSON.stringify(body, null, 2));
  }

  function sendResult<T extends object>(req: IncomingMessage, res: ServerResponse, result: BountyResult<T>, okStatus = 200): void {
    if (!result.ok) {
      send(req, res, STATUS_FOR_ERROR[result.error], { error: result.error, message: result.message });
      return;
    }
    const { ok: _ok, ...body } = result;
    send(req, res, okStatus, body);
  }

  /**
   * A malformed `%` escape (e.g. "%E0%A4%A") in a bounty id throws outside the shape this
   * function's own caller expects. The outer try/catch below already keeps that from crashing the
   * process, but it used to fall through to a generic 500 "internal error" — this gives it the
   * same clean 400 every other route's bad input gets. Returns `null` after already sending the
   * response, so the caller just needs to check for that and return.
   */
  function decodeBountyId(req: IncomingMessage, res: ServerResponse, raw: string): string | null {
    try {
      return decodeURIComponent(raw);
    } catch {
      send(req, res, 400, { error: "invalid_bounty", message: "malformed URL encoding in the bounty id" });
      return null;
    }
  }

  return async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (path !== "/bounties" && !path.startsWith("/bounties/")) return false;

    if (req.method === "OPTIONS") {
      send(req, res, 204);
      return true;
    }

    try {
      const token = bearerToken(req);

      if (path === "/bounties" && req.method === "POST") {
        sendResult(req, res, await service.open(token, await readJsonBody(req)), 201);
        return true;
      }
      if (path === "/bounties" && req.method === "GET") {
        sendResult(req, res, await service.list(url.searchParams.get("status") ?? undefined));
        return true;
      }

      const submissionsList = path.match(/^\/bounties\/([^/]+)\/submissions$/);
      if (submissionsList?.[1] && req.method === "GET") {
        const id = decodeBountyId(req, res, submissionsList[1]);
        if (id === null) return true;
        sendResult(req, res, await service.listSubmissions(id));
        return true;
      }
      if (submissionsList?.[1] && req.method === "POST") {
        const id = decodeBountyId(req, res, submissionsList[1]);
        if (id === null) return true;
        sendResult(req, res, await service.submit(token, id, await readJsonBody(req)), 201);
        return true;
      }

      const action = path.match(/^\/bounties\/([^/]+)\/(claim|cancel)$/);
      if (action?.[1] && req.method === "POST") {
        const id = decodeBountyId(req, res, action[1]);
        if (id === null) return true;
        const body = await readJsonBody(req);
        if (action[2] === "claim") {
          sendResult(req, res, await service.claim(token, id, body["submissionId"]));
        } else {
          sendResult(req, res, await service.cancel(token, id, body["reason"]));
        }
        return true;
      }

      const detail = path.match(/^\/bounties\/([^/]+)$/);
      if (detail?.[1] && req.method === "GET") {
        const id = decodeBountyId(req, res, detail[1]);
        if (id === null) return true;
        sendResult(req, res, await service.get(id));
        return true;
      }

      send(req, res, 404, { error: "not_found", message: `no route ${req.method} ${path}` });
      return true;
    } catch (cause) {
      if (cause instanceof BodyError) {
        send(req, res, cause.status, { error: "bad_request", message: cause.message });
        return true;
      }
      console.error("bounties: unhandled error", cause);
      send(req, res, 500, { error: "internal", message: "internal error" });
      return true;
    }
  };
}
