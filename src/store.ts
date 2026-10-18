import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Event, Operation, Session } from "./contracts.js";
import { BridgeError } from "./contracts.js";
export const STATE_SCHEMA_VERSION = 1;
export class Store {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, "state.sqlite"));
    const schema = Number(
      this.db.prepare("PRAGMA user_version").get()?.user_version,
    );
    if (schema > STATE_SCHEMA_VERSION) {
      this.db.close();
      throw new BridgeError(
        "state_version_newer",
        "This adapter state was upgraded by a newer release. Use a compatible release or an explicit quiescent backup restore; state was not changed.",
      );
    }
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events(sessionId TEXT NOT NULL,seq INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(sessionId,seq)); CREATE TABLE IF NOT EXISTS prompt_keys(keyHash TEXT PRIMARY KEY,sessionId TEXT NOT NULL);",
    );
    // Version zero is the original table layout. This migration only stamps
    // its existing additive schema; session JSON and replay fences are retained.
    if (schema === 0)
      this.db.exec(`PRAGMA user_version=${STATE_SCHEMA_VERSION}`);
  }
  session(id: string): Session | undefined {
    const row = this.db.prepare("SELECT body FROM sessions WHERE id=?").get(id);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  sessions(): Session[] {
    return this.db
      .prepare("SELECT body FROM sessions")
      .all()
      .map((row) => JSON.parse(String(row.body)) as Session);
  }
  saveSession(s: Session) {
    this.db
      .prepare("INSERT OR REPLACE INTO sessions VALUES(?,?)")
      .run(s.id, JSON.stringify(s));
  }
  operation(id: string): Operation | undefined {
    const row = this.db
      .prepare("SELECT body FROM operations WHERE id=?")
      .get(id);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  saveOperation(o: Operation) {
    this.db
      .prepare("INSERT OR REPLACE INTO operations VALUES(?,?,?)")
      .run(o.id, o.sessionId, JSON.stringify(o));
  }
  /** This prompt key is owned by the first ACP session that admits it. */
  promptOwner(keyHash: string): string | undefined {
    const row = this.db
      .prepare("SELECT sessionId FROM prompt_keys WHERE keyHash=?")
      .get(keyHash);
    return row ? String(row.sessionId) : undefined;
  }
  /** Called inside the admission transaction so ownership survives a crash. */
  claimPromptKey(keyHash: string, sessionId: string): string {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO prompt_keys(keyHash,sessionId) VALUES(?,?)",
      )
      .run(keyHash, sessionId);
    return this.promptOwner(keyHash)!;
  }
  create(cwd: string, mode: Session["mode"] = "supervised"): Session {
    const s: Session = {
      id: randomUUID(),
      cosId: null,
      cwd,
      mode,
      model: null,
      effort: null,
      seq: 0,
      title: "New ChatGPT conversation",
      updatedAt: Date.now(),
      activeInput: null,
      conversationId: null,
    };
    this.saveSession(s);
    return s;
  }
  events(id: string, after: number): Event[] {
    return this.db
      .prepare(
        "SELECT body FROM events WHERE sessionId=? AND seq>? ORDER BY seq LIMIT 200",
      )
      .all(id, after)
      .map((row) => JSON.parse(String(row.body)) as Event);
  }
  inputEvent(id: string, inputId: string): Event | undefined {
    const row = this.db
      .prepare(
        "SELECT body FROM events WHERE sessionId=? AND json_extract(body,'$.inputId')=? ORDER BY seq DESC LIMIT 1",
      )
      .get(id, inputId);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  /** Earliest recorded message carrying this exact input identity. */
  firstInputEvent(id: string, inputId: string): Event | undefined {
    const row = this.db
      .prepare(
        "SELECT body FROM events WHERE sessionId=? AND json_extract(body,'$.inputId')=? ORDER BY seq ASC LIMIT 1",
      )
      .get(id, inputId);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  /** Whether the recorded stream ever started this exact turn. Stock revises a
   * user message's own marker as a page-side boundary hint, so only this
   * proves an operation's link names a real turn. */
  turnStarted(id: string, turnId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS found FROM events WHERE sessionId=? AND json_extract(body,'$.kind')='turn_start' AND json_extract(body,'$.turnId')=? LIMIT 1",
      )
      .get(id, turnId);
    return !!row;
  }
  /** First recorded turn start after a sequence; the stock stream carries the
   * turn identity here rather than on the user message. */
  turnStart(id: string, after: number): Event | undefined {
    const row = this.db
      .prepare(
        "SELECT body FROM events WHERE sessionId=? AND seq>? AND json_extract(body,'$.kind')='turn_start' ORDER BY seq ASC LIMIT 1",
      )
      .get(id, after);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  turnEnd(id: string, turnId: string, after: number): Event | undefined {
    const row = this.db
      .prepare(
        "SELECT body FROM events WHERE sessionId=? AND seq>? AND json_extract(body,'$.kind')='turn_end' AND json_extract(body,'$.turnId')=? ORDER BY seq DESC LIMIT 1",
      )
      .get(id, after, turnId);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  append(s: Session, e: Event) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT OR IGNORE INTO events VALUES(?,?,?)")
        .run(s.id, e.seq, JSON.stringify(e));
      s.seq = Math.max(s.seq, e.seq);
      s.updatedAt = Date.now();
      this.saveSession(s);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
