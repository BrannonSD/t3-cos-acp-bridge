import { readFile } from "node:fs/promises";
import path from "node:path";
import { BridgeError, type Health, type Event } from "./contracts.js";
import { MainInstall } from "./main-install.js";
import {
  integrationMode,
  negotiate,
  supportedStockVersion,
  validateLegacyIdentity,
  windowsProcessStartedAt,
  type IntegrationMode,
} from "./compatibility.js";
export interface Endpoint {
  url: string;
  token: string;
  pid: number;
  startedAt: string;
  appVersion?: string;
}
export class Control {
  private readonly mainInstall: MainInstall;
  private verified?: Endpoint;
  private readonly processStarts = new Map<string, number>();
  constructor(
    readonly directory: string,
    readonly fixture?: Endpoint,
    readonly mode: IntegrationMode = integrationMode(),
    readonly processStartedAt = windowsProcessStartedAt,
  ) {
    this.mainInstall = new MainInstall(directory, mode);
  }
  async endpoint(): Promise<Endpoint> {
    if (this.fixture) {
      if (process.env.COS_ACP_TEST !== "1")
        throw new BridgeError(
          "unsafe_test_endpoint",
          "Test endpoint requires COS_ACP_TEST=1",
        );
      const u = new URL(this.fixture.url);
      if (u.hostname !== "127.0.0.1" || u.protocol !== "http:")
        throw new BridgeError(
          "non_loopback",
          "Only loopback HTTP is permitted",
        );
      return this.fixture;
    }
    try {
      const [raw, token] = await Promise.all([
        readFile(path.join(this.directory, "endpoint.json"), "utf8"),
        readFile(path.join(this.directory, "token"), "utf8"),
      ]);
      const e = JSON.parse(raw) as {
        protocol: number;
        port: number;
        pid: number;
        startedAt: string;
        appVersion?: string;
      };
      if (
        e.protocol !== 1 ||
        !Number.isInteger(e.port) ||
        e.port < 1 ||
        e.port > 65535 ||
        !Number.isInteger(e.pid) ||
        e.pid < 1 ||
        typeof e.startedAt !== "string" ||
        !e.startedAt ||
        !token.trim()
      )
        throw new Error("invalid endpoint");
      return {
        url: `http://127.0.0.1:${e.port}`,
        token: token.trim(),
        pid: e.pid,
        startedAt: e.startedAt,
        appVersion: e.appVersion,
      };
    } catch {
      throw new BridgeError(
        "control_unavailable",
        "Chat on Steroids is unavailable. Open it and enable the local control API and actions in Settings.",
      );
    }
  }
  async request<T>(route: string, body?: unknown): Promise<T> {
    if (body !== undefined && !this.verified) await this.health();
    const e = await this.endpoint();
    if (
      body !== undefined &&
      JSON.stringify(e) !== JSON.stringify(this.verified)
    )
      throw new BridgeError(
        "instance_changed",
        "CoS changed before this action. Its outcome remains fenced; resume the original session before retrying.",
      );
    let response: Response;
    try {
      response = await fetch(e.url + route, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${e.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(25_000),
        redirect: "error",
      });
    } catch {
      throw new BridgeError(
        "connection_lost",
        "Connection to Chat on Steroids was interrupted; any admitted input is retained for reconciliation.",
      );
    }
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new BridgeError(
        error.error ?? `http_${response.status}`,
        `Chat on Steroids request failed (${error.error ?? response.status}).`,
      );
    }
    return response.json() as Promise<T>;
  }
  async health() {
    if (!this.fixture) await this.mainInstall.ensure();
    const e = await this.endpoint();
    const health = await this.request<Health>("/v1/health");
    if (
      health.ok !== true ||
      health.protocol !== 1 ||
      health.pid !== e.pid ||
      (e.appVersion !== undefined && health.appVersion !== e.appVersion) ||
      !Array.isArray(health.routes) ||
      !Array.isArray(health.actions?.routes) ||
      typeof health.actions.enabled !== "boolean"
    )
      throw new BridgeError(
        "wrong_application",
        "The local endpoint is not the expected Chat on Steroids instance.",
      );
    const after = await this.endpoint();
    if (JSON.stringify(after) !== JSON.stringify(e))
      throw new BridgeError(
        "instance_changed",
        "CoS restarted while its identity was being checked. Retry the same session.",
      );
    if (health.startedAt !== e.startedAt) {
      if (
        this.mode !== "existing-install" ||
        health.integrationManifest ||
        health.appVersion === undefined ||
        health.appVersion !== e.appVersion ||
        !supportedStockVersion(health.appVersion)
      )
        throw new BridgeError(
          "wrong_application",
          "The local endpoint startup identity does not match CoS.",
        );
      let osStart: number;
      try {
        // A live PID's OS start time is immutable, and the probe costs a
        // PowerShell process; the stock listener/process timestamp split
        // would otherwise pay it on every health check. Cache it per PID +
        // app start marker, so a restarted app or a reused PID misses.
        const key = `${e.pid}:${health.startedAt}`;
        const cached = this.processStarts.get(key);
        if (cached !== undefined) {
          osStart = cached;
        } else {
          osStart = await this.processStartedAt(e.pid);
          if (this.processStarts.size >= 32) this.processStarts.clear();
          this.processStarts.set(key, osStart);
        }
      } catch {
        throw new BridgeError(
          "process_identity_unavailable",
          "The existing CoS process identity could not be verified.",
        );
      }
      validateLegacyIdentity(health, e, osStart);
    }
    health.integration = negotiate(health, this.mode);
    if (JSON.stringify(await this.endpoint()) !== JSON.stringify(e))
      throw new BridgeError(
        "instance_changed",
        "CoS changed during compatibility verification. Retry the same session.",
      );
    this.verified = e;
    return health;
  }
  async *stream(
    id: string,
    after: number,
    signal: AbortSignal,
  ): AsyncGenerator<Event> {
    await this.health();
    const e = await this.endpoint();
    const response = await fetch(
      `${e.url}/v1/sessions/${encodeURIComponent(id)}/events/stream`,
      {
        headers: {
          authorization: `Bearer ${e.token}`,
          "last-event-id": String(after),
        },
        signal,
        redirect: "error",
      },
    );
    if (!response.ok || !response.body)
      throw new BridgeError("stream_unavailable", "Event stream unavailable");
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      if (buffer.length > 2 * 1024 * 1024)
        throw new BridgeError(
          "oversized_event",
          "Event exceeds the stream limit",
        );
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end < 0) break;
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const event = JSON.parse(data) as Event;
        if (Number.isSafeInteger(event.seq) && event.seq > after) {
          after = event.seq;
          yield event;
        }
      }
    }
  }
}
