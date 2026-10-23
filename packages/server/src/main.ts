import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { pruneSessions } from "./auth/sessions.ts";
import { pruneAttempts } from "./auth/throttle.ts";
import { pruneAnonTraceShares } from "./services/anonTraceShares.ts";

const config = loadConfig();
const { app, ctx, worker } = await buildApp(config);

const housekeeping = setInterval(() => {
  try {
    pruneSessions(ctx.db);
    pruneAttempts(ctx.db);
    pruneAnonTraceShares(ctx);
  } catch (e) {
    app.log.warn({ err: e instanceof Error ? e.message : String(e) }, "housekeeping failed");
  }
}, 3600_000);

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "shutting down");
  clearInterval(housekeeping);
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  try {
    await app.close(); // stops the alert worker (waits for an in-flight tick) and closes the DB
    process.exit(0);
  } catch {
    process.exit(1);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (e) => app.log.error({ err: e instanceof Error ? e.message : String(e) }, "unhandled rejection"));

await app.listen({ port: config.port, host: config.host });
worker.start();
app.log.info(
  { port: config.port, db: config.dbPath, solana: config.solanaRpcCustom ? "custom endpoint" : "public endpoint", alertPollSec: config.alertPollSec, signup: config.allowSignup },
  "osstrace server ready",
);
