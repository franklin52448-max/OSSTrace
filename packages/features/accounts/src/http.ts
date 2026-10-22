import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeEmail } from "./password.ts";
import { AccountsRateLimiter, ipKey, type RateLimited } from "./rate-limit.ts";
import type { AccountService } from "./service.ts";
import type { AuthErrorCode, AuthResult } from "./types.ts";

/** Big enough for any real `{email, password}` body, small enough that nobody can stream megabytes at us. */
const MAX_BODY_BYTES = 16 * 1024;

const STATUS_FOR_ERROR: Record<AuthErrorCode, number> = {
  invalid_email: 400,
  invalid_password: 400,
  invalid_role: 400,
  email_taken: 409,
  invalid_credentials: 401,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  last_admin: 409,
};

export interface AccountsHttpOptions {
  /**
   * Exact origins allowed to call this API from a browser (CORS). Never `*`: these responses carry
   * session tokens. Defaults to the local web UI (`http://localhost:5301`).
   */
  allowedOrigins?: readonly string[];
  /**
   * The login/signup rate limiter (ADR 0015). Defaults to a fresh `AccountsRateLimiter` with the
   * default limits; pass one to change the limits or the clock, or to share one limiter between
   * several mounts of this handler in the same process.
   */
  rateLimiter?: AccountsRateLimiter;
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

/** A malformed `%`-escape is the client's mistake: a 400, not a 500 from the catch-all. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new BodyError(400, "malformed URL encoding in path");
  }
}

/** `Authorization: Bearer <token>` → token, or null. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

/**
 * Builds a request handler for the `/accounts/*` routes. Returns `true` if it handled the
 * request, `false` if the path isn't one of its routes — so it can be mounted inside another
 * server later (e.g. alongside the Explorer API) without owning the whole server.
 *
 * Routes (all JSON; errors are `{ "error": <AuthErrorCode or "bad_request">, "message": "..." }`):
 *   POST /accounts/signup           { email, password }  → 201 { user, session }
 *   POST /accounts/login            { email, password }  → 200 { user, session }
 *   (signup and login answer 429 + Retry-After when a rate limit trips; see ADR 0015)
 *   POST /accounts/logout           (Bearer)             → 204
 *   GET  /accounts/me               (Bearer)             → 200 { user }
 *   GET  /accounts/users            (Bearer, admin)      → 200 { users }
 *   PUT  /accounts/users/:id/role   (Bearer, admin) { role } → 200 { user }
 */
export function createAccountsHandler(
  service: AccountService,
  options: AccountsHttpOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const allowedOrigins = new Set(options.allowedOrigins ?? ["http://localhost:5301"]);
  const limiter = options.rateLimiter ?? new AccountsRateLimiter();

  function baseHeaders(req: IncomingMessage): Record<string, string> {
    const headers: Record<string, string> = {
      // Session tokens and account data must never be cached by a browser or proxy.
      "cache-control": "no-store",
      vary: "Origin",
    };
    const origin = req.headers["origin"];
    if (typeof origin === "string" && allowedOrigins.has(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers["access-control-allow-headers"] = "authorization, content-type";
      headers["access-control-allow-methods"] = "GET, POST, PUT, OPTIONS";
      // Not a CORS-safelisted response header, so the web UI can't read it unless it's exposed.
      headers["access-control-expose-headers"] = "retry-after";
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
    result: AuthResult<T>,
    okStatus = 200,
  ): void {
    if (!result.ok) {
      send(req, res, STATUS_FOR_ERROR[result.error], { error: result.error, message: result.message });
      return;
    }
    const { ok: _ok, ...body } = result;
    send(req, res, okStatus, body);
  }

  function sendRateLimited(req: IncomingMessage, res: ServerResponse, blocked: RateLimited): void {
    const seconds = Math.max(1, Math.ceil(blocked.retryAfterMs / 1000));
    res.writeHead(429, { ...baseHeaders(req), "content-type": "application/json", "retry-after": String(seconds) });
    res.end(
      JSON.stringify(
        { error: "rate_limited", message: `too many attempts; try again in ${seconds} seconds`, retryAfterSeconds: seconds },
        null,
        2,
      ),
    );
  }

  return async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (path !== "/accounts" && !path.startsWith("/accounts/")) return false;

    if (req.method === "OPTIONS") {
      send(req, res, 204);
      return true;
    }

    try {
      if (req.method === "POST" && path === "/accounts/signup") {
        // Counted before the body is read: every signup attempt costs an argon2 hash (or reveals
        // whether an email is taken), whether or not it succeeds.
        const blocked = limiter.signup(ipKey(req.socket.remoteAddress));
        if (blocked) {
          req.resume(); // drain the unread body so the connection can be reused
          sendRateLimited(req, res, blocked);
          return true;
        }
        const body = await readJsonBody(req);
        sendResult(req, res, await service.signup(body["email"], body["password"]), 201);
        return true;
      }

      if (req.method === "POST" && path === "/accounts/login") {
        const ip = ipKey(req.socket.remoteAddress);
        const flood = limiter.loginRequest(ip);
        if (flood) {
          req.resume();
          sendRateLimited(req, res, flood);
          return true;
        }
        const body = await readJsonBody(req);
        const email = typeof body["email"] === "string" ? normalizeEmail(body["email"]) : null;
        const attempt = limiter.loginAttempt(email, ip);
        if (attempt.limited) {
          sendRateLimited(req, res, attempt);
          return true;
        }
        let result;
        try {
          result = await service.login(body["email"], body["password"]);
        } catch (cause) {
          attempt.failed();
          throw cause;
        }
        if (result.ok) attempt.succeeded();
        else attempt.failed();
        sendResult(req, res, result);
        return true;
      }

      if (req.method === "POST" && path === "/accounts/logout") {
        const token = bearerToken(req);
        const auth = await service.authenticate(token);
        if (!auth.ok) {
          sendResult(req, res, auth);
          return true;
        }
        await service.logout(token as string);
        send(req, res, 204);
        return true;
      }

      if (req.method === "GET" && path === "/accounts/me") {
        sendResult(req, res, await service.authenticate(bearerToken(req)));
        return true;
      }

      if (req.method === "GET" && path === "/accounts/users") {
        sendResult(req, res, await service.listUsers(bearerToken(req)));
        return true;
      }

      const roleMatch = path.match(/^\/accounts\/users\/([^/]+)\/role$/);
      if (req.method === "PUT" && roleMatch?.[1]) {
        const body = await readJsonBody(req);
        sendResult(req, res, await service.setRole(bearerToken(req), decodeSegment(roleMatch[1]), body["role"]));
        return true;
      }

      send(req, res, 404, { error: "not_found", message: `no route ${req.method} ${path}` });
      return true;
    } catch (cause) {
      if (cause instanceof BodyError) {
        send(req, res, cause.status, { error: "bad_request", message: cause.message });
        return true;
      }
      // Never echo internal error details (file paths, stack traces) to the client.
      console.error("accounts: unhandled error", cause);
      send(req, res, 500, { error: "internal", message: "internal error" });
      return true;
    }
  };
}
