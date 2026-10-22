import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { nowIso } from "../lib/time.ts";

export type Row = Record<string, SQLInputValue>;
export type Param = SQLInputValue;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/** Thin wrapper over node:sqlite with a statement cache and a re-entrant transaction helper. */
export class Db {
  readonly raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec("PRAGMA busy_timeout = 5000");
    this.raw.exec("PRAGMA synchronous = NORMAL");
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }
  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }
  run(sql: string, ...params: Param[]): { changes: number } {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes) };
  }
  exec(sql: string) {
    this.raw.exec(sql);
  }

  /** Runs fn inside one IMMEDIATE transaction (nested calls join the outer one). fn must be synchronous. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.raw.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    } finally {
      this.depth = 0;
    }
  }

  migrate(): string[] {
    this.raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const done = new Set(this.all<{ version: string }>("SELECT version FROM schema_migrations").map((r) => r.version));
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
      .sort();
    const applied: string[] = [];
    for (const f of files) {
      const version = f.replace(/\.sql$/, "");
      if (done.has(version)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      this.tx(() => {
        this.raw.exec(sql);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", version, nowIso());
      });
      applied.push(version);
    }
    return applied;
  }

  close() {
    this.cache.clear();
    this.raw.close();
  }
}

export function openDb(path: string): Db {
  const db = new Db(path);
  db.migrate();
  return db;
}
