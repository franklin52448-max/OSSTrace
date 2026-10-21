import type { IncomingMessage, ServerResponse } from "node:http";
import { bearerToken } from "@opentrace/accounts";
import type { LabelSubmissionService } from "./service.ts";
import type { SubmissionErrorCode, SubmissionResult } from "./types.ts";

/** Generous for a name + URL + description, small enough that nobody can stream megabytes at us. */
const MAX_BODY_BYTES = 16 * 1024;

const STATUS_FOR_ERROR: Record<SubmissionErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  own_submission: 403,
  invalid_submission: 400,
  not_found: 404,
  duplicate_submission: 409,
  already_reviewed: 409,
};

export interface LabelSubmissionsHttpOptions {
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
 * Request handler for the `/labels/submissions` routes. Returns `false` for any other path, so it
 * can be mounted inside another server, same as `createAccountsHandler`.
 *
 *   POST /labels/submissions                 (Bearer)            body → 201 { submission }
 *   GET  /labels/submissions/mine            (Bearer)                 → 200 { submissions }
 *   GET  /labels/submissions?status=…        (Bearer, moderator)      → 200 { submissions }
 *   POST /labels/submissions/:id/confirm     (Bearer, moderator)      → 200 { submission }
 *   POST /labels/submissions/:id/reject      (Bearer, moderator) { reason } → 200 { submission }
 *
 * Errors are `{ "error": <SubmissionErrorCode or "bad_request">, "message": "..." }`.
 */
export function createLabelSubmissionsHandler(
  service: LabelSubmissionService,
  options: LabelSubmissionsHttpOptions = {},
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

  function sendResult<T extends object>(req: IncomingMessage, res: ServerResponse, result: SubmissionResult<T>, okStatus = 200): void {
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
    if (path !== "/labels/submissions" && !path.startsWith("/labels/submissions/")) return false;

    if (req.method === "OPTIONS") {
      send(req, res, 204);
      return true;
    }

    try {
      const token = bearerToken(req);

      if (path === "/labels/submissions" && req.method === "POST") {
        sendResult(req, res, await service.submit(token, await readJsonBody(req)), 201);
        return true;
      }
      if (path === "/labels/submissions" && req.method === "GET") {
        sendResult(req, res, await service.listForReview(token, url.searchParams.get("status") ?? "community"));
        return true;
      }
      if (path === "/labels/submissions/mine" && req.method === "GET") {
        sendResult(req, res, await service.listMine(token));
        return true;
      }
      const action = path.match(/^\/labels\/submissions\/([^/]+)\/(confirm|reject)$/);
      if (action?.[1] && req.method === "POST") {
        const id = decodeURIComponent(action[1]);
        if (action[2] === "confirm") {
          sendResult(req, res, await service.confirm(token, id));
        } else {
          const body = await readJsonBody(req);
          sendResult(req, res, await service.reject(token, id, body["reason"]));
        }
        return true;
      }

      send(req, res, 404, { error: "not_found", message: `no route ${req.method} ${path}` });
      return true;
    } catch (cause) {
      if (cause instanceof BodyError) {
        send(req, res, cause.status, { error: "bad_request", message: cause.message });
        return true;
      }
      console.error("community-labels: unhandled error", cause);
      send(req, res, 500, { error: "internal", message: "internal error" });
      return true;
    }
  };
}
