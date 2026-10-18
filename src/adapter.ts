import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { randomUUID } from "node:crypto";
import { BrokerClient } from "./broker.js";
import {
  BridgeError,
  type Approval,
  type Attachment,
  type Event,
  type Models,
  type Operation,
  type Session,
} from "./contracts.js";
import { sleep } from "./engine.js";
import { belongsToInput, isCoSContinuation } from "./continuation.js";
import { FinalAnswerProjection } from "./final-answer.js";
import { authoredT3Text, coST3Prompt } from "./t3-context.js";
import {
  sessionCommands,
  options,
  Translator,
  v2Options,
} from "./translate.js";
export interface Gateway {
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
}
type Context = {
  notify(method: string, params: unknown): Promise<void>;
  request<R = unknown>(method: string, params: unknown): Promise<R>;
};
interface State {
  session: Session;
  operation?: Operation;
  events: Event[];
}
const info = {
  name: "chat-on-steroids",
  title: "Chat on Steroids",
  version: "0.1.0",
};
export class Adapter {
  private clientName?: string;
  private nativeWorkerRouting = false;
  connectionSignal?: AbortSignal;
  readonly sessions = new Map<string, Session>();
  readonly translators = new Map<string, Translator>();
  readonly active = new Map<string, Promise<v1.PromptResponse>>();
  readonly permissionRequests = new Set<string>();
  readonly sentCursors = new Map<string, number>();
  readonly workerCursors = new Map<string, number>();
  readonly workerStatuses = new Map<string, string>();
  readonly workerRotation = new Map<string, number>();
  readonly compactionSnapshots = new Map<string, string>();
  readonly automationSnapshots = new Map<string, string>();
  constructor(
    readonly gateway: Gateway = new BrokerClient(),
    readonly version: 1 | 2 = 1,
  ) {}
  private async update(client: Context, id: string, update: unknown) {
    await client.notify("session/update", { sessionId: id, update });
  }
  private translator(id: string) {
    let t = this.translators.get(id);
    if (!t) {
      t = new Translator(this.version);
      this.translators.set(id, t);
    }
    return t;
  }
  async initialize(params?: {
    clientInfo?: { name: string } | null;
    info?: { name: string } | null;
    clientCapabilities?: { _meta?: Record<string, unknown> | null };
    capabilities?: { _meta?: Record<string, unknown> | null };
  }): Promise<v1.InitializeResponse | v2.InitializeResponse> {
    this.clientName = params?.clientInfo?.name ?? params?.info?.name;
    this.nativeWorkerRouting =
      params?.clientCapabilities?._meta?.["chat-on-steroids/worker"] === true ||
      params?.capabilities?._meta?.["chat-on-steroids/worker"] === true;
    let health: {
      actions: { routes: string[] };
      integration?: import("./compatibility.js").Compatibility;
    };
    try {
      health = await this.gateway.call("health");
    } catch (error) {
      // SDK defaults to an unhelpful "Internal error" headline for plain
      // Error subclasses. Preserve only the adapter's vetted public messages.
      if (error instanceof BridgeError)
        throw v1.RequestError.internalError(
          { code: error.code },
          error.message,
        );
      throw error;
    }
    const image =
      health.integration?.attachments ||
      health.integration?.tier === "existing-install" ||
      health.actions.routes.includes("POST /v1/attachments");
    const meta = health.integration
      ? { "chat-on-steroids/integration": health.integration }
      : undefined;
    if (this.version === 1) {
      const response: v1.InitializeResponse = {
        protocolVersion: 1,
        agentInfo: info,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image, embeddedContext: image },
          sessionCapabilities: { list: {}, resume: {}, close: {} },
        },
        authMethods: [],
        ...(meta ? { _meta: meta } : {}),
      };
      return response;
    }
    const response: v2.InitializeResponse = {
      protocolVersion: 2,
      info,
      capabilities: {
        session: {
          prompt: {
            image: image ? {} : undefined,
            embeddedContext: image ? {} : undefined,
          },
        },
      },
      authMethods: [],
      ...(meta ? { _meta: meta } : {}),
    };
    return response;
  }
  async configuration(s: Session) {
    const models = await this.gateway.call<Models>("models");
    return this.version === 1 ? options(s, models) : v2Options(s, models);
  }
  async create(cwd: string) {
    const s = await this.gateway.call<Session>("new", {
      cwd,
      clientName: this.clientName,
    });
    this.sessions.set(s.id, s);
    return {
      sessionId: s.id,
      configOptions: await this.configuration(s),
      ...(this.version === 2
        ? {
            availableCommands: sessionCommands(s).map((c) => ({
              ...c,
              ...(c.input ? { input: { type: "text", ...c.input } } : {}),
            })),
          }
        : {
            modes: {
              currentModeId: s.mode,
              availableModes: [
                ...(s.compatibility === "existing-install"
                  ? []
                  : [{ id: "supervised", name: "Supervised" }]),
                {
                  id: "cos",
                  name:
                    s.compatibility === "existing-install"
                      ? "CoS permissions (T3 supervision unavailable)"
                      : "CoS permissions",
                },
              ],
            },
          }),
    };
  }
  async load(id: string, cwd: string, client: Context, replay = true) {
    const s = await this.gateway.call<Session>("load", { sessionId: id, cwd });

    this.sessions.set(s.id, s);
    if (s.id !== id) {
      /* Imported native IDs are aliased at the ACP boundary without inventing a ChatGPT id. */ this.sessions.set(
        id,
        s,
      );
    }
    if (replay) {
      // T3 persists its own thread transcript. Replaying every CoS message on
      // load makes stock ACP v1 concatenate historical assistant responses
      // into a new assistant bubble. Only native CoS imports need full replay.
      const t3Persisted = this.clientName === "t3-code" && s.id === id;
      let after = t3Persisted ? (s.activeInput ? 0 : s.seq) : 0;
      for (;;) {
        const state = await this.gateway.call<State>("state", {
          sessionId: s.id,
          after,
        });
        for (const e of state.events) {
          const op = state.operation;
          if (
            (!t3Persisted || (s.activeInput && belongsToInput(e, op))) &&
            !(this.clientName === "t3-code" && e.kind === "user_message") &&
            !isCoSContinuation(e)
          ) {
            for (const u of await this.eventUpdates(id, s, e))
              await this.update(client, id, u);
          }
          after = e.seq;
        }
        if (state.events.length < 200) break;
      }
      this.sentCursors.set(id, after);
      // A finished CoS worker may already be absent from the live worker
      // list. Replay confirmed child activity using its recorded origin.
      if (s.compatibility === "existing-install" && s.cosId)
        await this.workers(id, s, client).catch(() => undefined);
    }
    if (this.version === 2) {
      await this.update(client, id, {
        sessionUpdate: "state_update",
        state: s.activeInput ? "running" : "idle",
      });
      if (s.activeInput) this.beginMonitor(id, s, client);
    }
    await this.advertise(id, client);
    return { configOptions: await this.configuration(s) };
  }
  private async eventUpdates(
    id: string,
    s: Session,
    event: Event,
    workerSessionId?: string,
  ): Promise<Array<Record<string, unknown>>> {
    if (
      event.kind === "user_message" &&
      event.message &&
      this.clientName === "t3-code"
    )
      event = {
        ...event,
        message: { ...event.message, text: authoredT3Text(event.message.text) },
      };
    if (event.kind !== "native_image") return this.translator(id).event(event);
    const assets = (event.assets ?? []).filter(
      (asset) =>
        /^image\/(?:png|jpeg|webp|gif)$/.test(asset.mimeType) &&
        /^[0-9a-f]{8,64}\.(?:png|jpg|bin)$/.test(asset.id) &&
        Number.isSafeInteger(asset.bytes) &&
        asset.bytes > 0 &&
        asset.bytes <= 8 * 1024 * 1024,
    );
    const updates: Array<Record<string, unknown>> = [];
    for (const asset of assets.slice(0, 4)) {
      try {
        const result = await this.gateway.call<{
          asset: { id: string; data: string };
        }>("asset", {
          sessionId: s.id,
          assetId: asset.id,
          ...(workerSessionId ? { workerSessionId } : {}),
        });
        const data = result.asset?.data;
        if (
          result.asset?.id !== asset.id ||
          typeof data !== "string" ||
          data.length > Math.ceil((8 * 1024 * 1024) / 3) * 4 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
        )
          throw new BridgeError(
            "invalid_asset",
            "Image data failed validation.",
          );
        const content = { type: "image", data, mimeType: asset.mimeType };
        updates.push(
          this.version === 2
            ? {
                sessionUpdate: "agent_message",
                messageId: `cos-image:${event.seq}:${asset.id}`,
                content: [content],
              }
            : { sessionUpdate: "agent_message_chunk", content },
        );
      } catch {
        updates.push(
          ...this.translator(id).note(
            "A generated image was unavailable in T3. View the original in Chat on Steroids.",
          ),
        );
      }
    }
    if (!updates.length)
      updates.push(
        ...this.translator(id).note(
          "A generated image has no supported retained image asset. View it in Chat on Steroids.",
        ),
      );
    return updates;
  }
  private resolve(id: string) {
    const s = this.sessions.get(id);
    if (!s)
      throw new BridgeError(
        "session_not_loaded",
        "Resume the conversation before sending a prompt.",
      );
    return s;
  }
  async list(cursor?: string, cwd?: string) {
    const result = await this.gateway.call<{
      sessions: Array<{
        id: string;
        title: string;
        updatedAt: number;
        cwd?: string | null;
      }>;
      nextCursor: string | null;
    }>("list", { cursor });
    return {
      sessions: result.sessions
        .filter(
          (s) => s.cwd && (!cwd || s.cwd.toLowerCase() === cwd.toLowerCase()),
        )
        .map((s) => ({
          sessionId: s.id,
          cwd: s.cwd!,
          title: s.title,
          updatedAt: new Date(s.updatedAt).toISOString(),
        })),
      nextCursor: result.nextCursor,
    };
  }
  async set(id: string, configId: string, value: string, client: Context) {
    const s = this.resolve(id);
    if (configId === "mode" && value !== "cos" && value !== "supervised")
      throw new BridgeError(
        "invalid_option",
        "Select a supported CoS permission mode.",
      );
    const values =
      configId === "mode"
        ? { mode: value === "cos" ? "cos" : "supervised" }
        : configId === "model"
          ? { model: value }
          : configId === "reasoning"
            ? { effort: value }
            : null;
    if (!values)
      throw new BridgeError(
        "unknown_option",
        "This configuration option is not supported.",
      );
    const updated = await this.gateway.call<Session>("set", {
      sessionId: s.id,
      ...values,
    });
    this.sessions.set(id, updated);
    const configOptions = await this.configuration(updated);
    await this.update(client, id, {
      sessionUpdate:
        this.version === 2 ? "config_option_update" : "config_option_update",
      configOptions,
    });
    return { configOptions };
  }
  async advertise(id: string, client: Context) {
    await this.update(client, id, {
      sessionUpdate: "available_commands_update",
      availableCommands: sessionCommands(this.resolve(id)).map((c) => ({
        ...c,
        ...(this.version === 2 && c.input
          ? { input: { type: "text", ...c.input } }
          : {}),
      })),
    });
  }
  async content(prompt: ReadonlyArray<unknown>, sessionId?: string) {
    const stock =
      sessionId && this.resolve(sessionId).compatibility === "existing-install";
    const staged = async (file: {
      data: string;
      name: string;
      mimeType?: string;
    }) => {
      if (stock) {
        const result = await this.gateway.call<{
          path: string;
          name: string;
          mimeType: string;
        }>("stage", { sessionId, ...file });
        text.push(
          "[T3 attachment: " +
            JSON.stringify(result.name) +
            " (" +
            result.mimeType +
            ") staged at " +
            JSON.stringify(result.path) +
            ". Use the CoS file/image viewing tool to inspect this exact local file before responding about its contents.]",
        );
      } else {
        const result = await this.gateway.call<{ attachment: Attachment }>(
          "upload",
          { name: file.name, data: file.data },
        );
        attachments.push(result.attachment);
      }
    };
    const text: string[] = [];
    const attachments: Attachment[] = [];
    for (const raw of prompt) {
      const block = raw as {
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
        uri?: string;
        name?: string;
        resource?: {
          uri: string;
          text?: string;
          blob?: string;
          mimeType?: string;
        };
      };
      switch (block.type) {
        case "text":
          text.push(block.text ?? "");
          break;
        case "resource_link":
          if (
            stock &&
            typeof block.uri === "string" &&
            block.uri.startsWith("file:")
          ) {
            const result = await this.gateway.call<{
              path: string;
              name: string;
            }>("stage-reference", { sessionId, uri: block.uri });
            text.push(
              "[T3 referenced file: " +
                JSON.stringify(result.name) +
                " staged at " +
                JSON.stringify(result.path) +
                ". Use CoS file tools to inspect this exact local file.]",
            );
          } else {
            text.push(
              "[Referenced resource: " +
                (block.name ?? block.uri) +
                "] " +
                block.uri,
            );
          }
          break;
        case "image": {
          if (!block.data)
            throw new BridgeError(
              "invalid_attachment",
              "Image data is missing.",
            );
          await staged({
            name:
              block.name ??
              (block.mimeType === "image/jpeg" ? "image.jpg" : "image.png"),
            mimeType: block.mimeType ?? "image/png",
            data: block.data,
          });
          break;
        }
        case "resource": {
          const resource = block.resource;
          if (!resource)
            throw new BridgeError(
              "invalid_attachment",
              "Resource data is missing.",
            );
          if (resource.text !== undefined) text.push(resource.text);
          else if (resource.blob) {
            await staged({
              name: resource.uri.split("/").pop() ?? "attachment",
              mimeType: resource.mimeType,
              data: resource.blob,
            });
          } else
            throw new BridgeError(
              "invalid_attachment",
              "Resource has no supported content.",
            );
          break;
        }
        default:
          throw new BridgeError(
            "unsupported_content",
            `Content type ${block.type} is not supported by Chat on Steroids.`,
          );
      }
    }
    return { text: text.join("\n\n"), attachments };
  }
  async prompt(
    id: string,
    prompt: ReadonlyArray<unknown>,
    meta: Record<string, unknown> | null | undefined,
    client: Context,
    signal: AbortSignal,
  ) {
    const s = this.resolve(id);
    const { text, attachments } = await this.content(prompt, id);
    if (
      (text.startsWith("/cos-") || text.trim() === "/compact") &&
      !attachments.length
    )
      return this.command(id, text, client);
    const key =
      typeof meta?.promptId === "string"
        ? meta.promptId
        : typeof meta?.requestId === "string"
          ? meta.requestId
          : undefined;
    const op = await this.gateway.call<Operation>("start", {
      sessionId: s.id,
      text: this.clientName === "t3-code" ? coST3Prompt(text) : text,
      attachments,
      key,
    });
    if (this.version === 2) {
      if (this.clientName !== "t3-code")
        await this.update(client, id, {
          sessionUpdate: "user_message",
          messageId: op.id,
          content: prompt,
        });
      await this.update(client, id, {
        sessionUpdate: "state_update",
        state: "running",
      });
      this.beginMonitor(id, s, client);
      return { messageId: op.id };
    }
    await this.advertise(id, client);
    return this.monitor(id, s, client, signal);
  }
  private beginMonitor(id: string, s: Session, client: Context) {
    if (this.active.has(id)) return;
    const task = this.monitor(id, s, client)
      .catch(async (error) => {
        await client
          .notify("_cos/session/retrying", {
            sessionId: id,
            category: "connection",
            detail:
              error instanceof BridgeError
                ? error.message
                : "The integration connection was interrupted.",
          })
          .catch(() => undefined);
        return { stopReason: "cancelled" as const };
      })
      .finally(() => this.active.delete(id));
    this.active.set(id, task);
  }
  private async permissions(id: string, s: Session, client: Context) {
    if (s.mode !== "supervised") return;
    const { approvals } = await this.gateway.call<{ approvals: Approval[] }>(
      "approvals",
      { sessionId: s.id },
    );
    for (const a of approvals) {
      if (this.permissionRequests.has(a.id)) continue;
      this.permissionRequests.add(a.id);
      void (async () => {
        try {
          if (this.version === 2)
            await this.update(client, id, {
              sessionUpdate: "state_update",
              state: "requires_action",
            });
          const response = await client.request<{
            outcome: { outcome: string; optionId?: string };
          }>(
            "session/request_permission",
            this.version === 1
              ? {
                  sessionId: id,
                  toolCall: {
                    toolCallId: a.id,
                    title: a.title,
                    kind: "other",
                    status: "pending",
                    rawInput: a.description,
                  },
                  options: [
                    {
                      optionId: "allow_once",
                      name: "Allow once",
                      kind: "allow_once",
                    },
                    {
                      optionId: "reject_once",
                      name: "Reject",
                      kind: "reject_once",
                    },
                  ],
                }
              : {
                  sessionId: id,
                  title: a.title,
                  description: a.description,
                  subject: { type: "tool_call", toolCallId: a.id },
                  options: [
                    {
                      optionId: "allow_once",
                      name: "Allow once",
                      kind: "allow_once",
                    },
                    {
                      optionId: "reject_once",
                      name: "Reject",
                      kind: "reject_once",
                    },
                  ],
                },
          );
          await this.gateway.call("resolve", {
            sessionId: s.id,
            id: a.id,
            decision:
              response.outcome.outcome === "selected" &&
              response.outcome.optionId === "allow_once"
                ? "allow_once"
                : "reject_once",
          });
          if (this.version === 2)
            await this.update(client, id, {
              sessionUpdate: "state_update",
              state: "running",
            });
        } catch {
          /* An unanswered or disconnected approval expires closed in CoS. */
        } finally {
          this.permissionRequests.delete(a.id);
        }
      })();
    }
  }
  /** Read-only projection of actual native compaction and automation state. */
  private async nativeActivity(id: string, s: Session, client: Context) {
    if (!s.cosId) return;
    const { live } = await this.gateway.call<{
      live?: {
        automation?: string;
        job?: {
          stage: string;
          startedAt: number;
          automatic: boolean;
          busy: boolean;
          error?: string | null;
        } | null;
      } | null;
    }>("live", { sessionId: s.id });
    if (!live) return;
    if (["off", "goal", "loop"].includes(live.automation ?? "")) {
      const previous = this.automationSnapshots.get(id);
      if (previous !== live.automation) {
        this.automationSnapshots.set(id, live.automation!);
        if (live.automation !== "off" || (previous && previous !== "off")) {
          for (const update of this.translator(id).note(
            "Chat on Steroids automation: " + live.automation + ".",
          ))
            await this.update(client, id, update);
        }
      }
    }
    const job = live.job;
    if (
      !job ||
      !Number.isSafeInteger(job.startedAt) ||
      job.startedAt <= 0 ||
      ![
        "handoff-pending",
        "opening",
        "waiting-for-browser",
        "done",
        "failed",
      ].includes(job.stage)
    )
      return;
    const status =
      job.stage === "done"
        ? "completed"
        : job.stage === "failed"
          ? "failed"
          : "in_progress";
    const key = id + ":" + job.startedAt;
    const snapshot = status + ":" + job.stage + ":" + (job.error ?? "");
    if (this.compactionSnapshots.get(key) === snapshot) return;
    this.compactionSnapshots.set(key, snapshot);
    const compactionId = "cos-compaction:" + job.startedAt;
    const update =
      this.version === 2
        ? {
            sessionUpdate: "compaction_update",
            compactionId,
            status,
            ...(job.error && status === "failed"
              ? { error: job.error.slice(0, 400) }
              : {}),
            _meta: {
              "chat-on-steroids/compaction": {
                stage: job.stage,
                automatic: job.automatic,
              },
            },
          }
        : {
            sessionUpdate: "tool_call_update",
            toolCallId: compactionId,
            title: "Compact context",
            kind: "think",
            status: status === "in_progress" ? "in_progress" : status,
            rawOutput: job.error ?? "CoS handoff: " + job.stage,
          };
    await this.update(client, id, update);
  }
  private async workers(
    id: string,
    s: Session,
    client: Context,
  ): Promise<boolean> {
    try {
      await this.nativeActivity(id, s, client).catch(() => undefined);
      const { workers } = await this.gateway.call<{
        workers: Array<{
          id: string;
          runId?: string | null;
          sessionId?: string | null;
          label: string;
          state: string;
        }>;
      }>("workers", { sessionId: s.id });
      let active = false;
      for (const w of workers) {
        if (["invited", "active", "detached", "waking"].includes(w.state))
          active = true;
        const status = /^(done|completed|finished)$/.test(w.state)
          ? "completed"
          : /^(failed|error)$/.test(w.state)
            ? "failed"
            : /^(cancelled|stopped)$/.test(w.state)
              ? "cancelled"
              : /^(waiting|sleeping|parked)$/.test(w.state)
                ? "waiting"
                : "running";
        const key = `${id}:${w.runId ?? s.cosId}:${w.id}`;
        const version = JSON.stringify([status, w.sessionId, w.label]);
        if (this.workerStatuses.get(key) !== version) {
          await this.update(client, id, {
            sessionUpdate:
              this.version === 2 ? "tool_call_update" : "tool_call",
            toolCallId: `cos-worker:${w.runId ?? s.cosId}:${w.id}`,
            title: w.label || w.id,
            kind: "other",
            status:
              status === "running"
                ? "in_progress"
                : status === "waiting"
                  ? "pending"
                  : status,
            _meta: {
              "chat-on-steroids/worker": {
                id: w.id,
                sessionId: w.sessionId,
                title: w.label,
                prompt: w.label,
                status,
              },
            },
          });
          this.workerStatuses.set(key, version);
        }
      }
      // The child sessions are readable only when CoS identifies them as
      // workers of this exact parent. Rotate a bounded batch of children.
      const linked = workers.filter(
        (w): w is typeof w & { sessionId: string } =>
          typeof w.sessionId === "string" && w.sessionId.length > 0,
      );
      const offset = this.workerRotation.get(id) ?? 0;
      for (let i = 0; i < Math.min(4, linked.length); i++) {
        const w = linked[(offset + i) % linked.length]!;
        const key = `${id}:child:${w.sessionId}`;
        let after = this.workerCursors.get(key) ?? 0;
        for (let page = 0; page < 2; page++) {
          let data: { events: Event[] };
          try {
            data = await this.gateway.call("worker-events", {
              sessionId: s.id,
              workerSessionId: w.sessionId,
              after,
            });
          } catch (error) {
            if (
              error instanceof BridgeError &&
              ["session_not_found", "worker_not_in_session"].includes(
                error.code,
              )
            )
              break;
            throw error;
          }
          for (const event of data.events) {
            // Worker instructions belong to the child's own conversation.
            // Stock generic T3 must not mistake them for a new parent user
            // prompt, including when a worker is discovered after startup.
            if (
              this.clientName === "t3-code" &&
              !this.nativeWorkerRouting &&
              event.kind === "user_message"
            ) {
              after = Math.max(after, event.seq);
              this.workerCursors.set(key, after);
              continue;
            }
            // Stock generic T3 ACP has no CoS-specific child-thread parser.
            // Keep child messages inside stable worker tool cards rather than
            // incorrectly appending them to the parent's assistant response.
            if (
              this.clientName === "t3-code" &&
              !this.nativeWorkerRouting &&
              event.kind === "assistant_message"
            ) {
              const workerFinalStatus = /^(done|completed|finished)$/.test(
                w.state,
              )
                ? "completed"
                : /^(failed|error)$/.test(w.state)
                  ? "failed"
                  : /^(cancelled|stopped)$/.test(w.state)
                    ? "cancelled"
                    : "in_progress";
              await this.update(client, id, {
                sessionUpdate: "tool_call_update",
                toolCallId: "cos-worker:" + (w.runId ?? s.cosId) + ":" + w.id,
                title: w.label || w.id,
                kind: "other",
                status: workerFinalStatus,
                rawOutput: (event.message?.text ?? "").slice(0, 4000),
                _meta: {
                  "chat-on-steroids/worker": {
                    id: w.id,
                    sessionId: w.sessionId,
                    title: w.label,
                  },
                },
              });
            } else {
              for (const update of await this.eventUpdates(
                key,
                s,
                event,
                w.sessionId,
              ))
                await this.update(
                  client,
                  id,
                  this.clientName === "t3-code" &&
                    !this.nativeWorkerRouting &&
                    (update.sessionUpdate === "tool_call" ||
                      update.sessionUpdate === "tool_call_update")
                    ? {
                        ...update,
                        toolCallId:
                          "cos-worker-step:" +
                          w.sessionId +
                          ":" +
                          update.toolCallId,
                        title:
                          (w.label || w.id) + " / " + (update.title ?? "Tool"),
                        _meta: {
                          ...(update._meta as
                            | Record<string, unknown>
                            | undefined),
                          "chat-on-steroids/workerContext": {
                            sessionId: w.sessionId,
                          },
                        },
                      }
                    : {
                        ...update,
                        _meta: {
                          ...(update._meta as
                            | Record<string, unknown>
                            | undefined),
                          "chat-on-steroids/workerContext": {
                            sessionId: w.sessionId,
                          },
                        },
                      },
                );
            }
            after = Math.max(after, event.seq);
            this.workerCursors.set(key, after);
          }
          if (data.events.length < 200) break;
        }
      }
      if (linked.length)
        this.workerRotation.set(id, (offset + 4) % linked.length);
      return active;
    } catch (error) {
      if (
        error instanceof BridgeError &&
        ["workers_disabled", "unknown_route"].includes(error.code)
      )
        return false;
      throw error;
    }
  }
  private async monitor(
    id: string,
    s: Session,
    client: Context,
    signal?: AbortSignal,
  ): Promise<v1.PromptResponse> {
    let after = this.sentCursors.get(id) ?? s.seq;
    const finalAnswers = new FinalAnswerProjection();
    let controlsAt = 0;
    let childActive = false;
    let uncertainNotifiedAt = 0;
    let failures = 0;
    for (;;) {
      if (this.connectionSignal?.aborted)
        throw new BridgeError(
          "client_disconnected",
          "T3 disconnected. Resume the session to continue monitoring its original input.",
        );
      if (signal?.aborted) {
        await this.cancel(id);
        throw new BridgeError(
          "client_cancelled",
          "Cancellation requested; reconnect to confirm the exact turn ended.",
        );
      }
      let state: State;
      try {
        state = await this.gateway.call<State>("state", {
          sessionId: s.id,
          after,
        });
        failures = 0;
      } catch (error) {
        if (++failures === 1)
          await client.notify("_cos/session/retrying", {
            sessionId: id,
            category: "connection",
            detail:
              "Reconnecting to Chat on Steroids. Input identity is retained.",
          });
        if (failures > 30) throw error;
        await sleep(Math.min(5000, 500 * failures));
        continue;
      }
      for (const event of state.events) {
        // CoS may revise prior-turn text during a later turn. Stock T3 ACP v1
        // would append this history to the currently streaming assistant bubble.
        // Only emit content owned by the admitted input and its continuations.
        const suppressed =
          (this.clientName === "t3-code" &&
            (event.kind === "user_message" ||
              !belongsToInput(event, state.operation))) ||
          isCoSContinuation(event);
        if (!suppressed) {
          const updates =
            this.clientName === "t3-code" &&
            event.kind === "assistant_message" &&
            typeof event.final === "boolean"
              ? finalAnswers.message(event, this.translator(id))
              : await this.eventUpdates(id, s, event);
          for (const update of updates) await this.update(client, id, update);
          if (this.clientName === "t3-code" && event.kind === "turn_end")
            for (const update of finalAnswers.end(event, this.translator(id)))
              await this.update(client, id, update);
        }
        after = event.seq;
        this.sentCursors.set(id, after);
      }
      if (Date.now() - controlsAt > (childActive ? 1000 : 4000)) {
        controlsAt = Date.now();
        try {
          await this.permissions(id, state.session, client);
          childActive = await this.workers(id, state.session, client);
        } catch {
          // A transient control-channel failure (identity re-verification,
          // broker restart) must never abandon the running turn: the state
          // poll above still decides completion, and the next tick retries
          // the controls with the previous child activity as the fallback.
        }
      }
      const op = state.operation;
      if (
        state.events.length < 200 &&
        !childActive &&
        (!state.session.activeInput ||
          (op && ["complete", "cancelled", "failed"].includes(op.phase)))
      ) {
        if (this.clientName === "t3-code")
          for (const update of finalAnswers.finish(this.translator(id)))
            await this.update(client, id, update);
        const reason = op?.phase === "cancelled" ? "cancelled" : "end_turn";
        if (this.version === 2)
          await this.update(client, id, {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: reason,
          });
        return { stopReason: reason };
      }
      if (
        op?.phase === "uncertain" &&
        op.delivery === "unconfirmed" &&
        failures === 0 &&
        Date.now() - uncertainNotifiedAt > 15_000
      ) {
        uncertainNotifiedAt = Date.now();
        await client.notify("_cos/session/retrying", {
          sessionId: id,
          category: "unknown",
          detail:
            "Message outcome unconfirmed. CoS will reconcile the original input without resending it.",
        });
      }
      await sleep(500);
    }
  }
  async cancel(id: string) {
    const sessionId = this.resolve(id).id;
    const { approvals } = await this.gateway.call<{ approvals: Approval[] }>(
      "approvals",
      { sessionId },
    );
    for (const approval of approvals)
      await this.gateway.call("resolve", {
        sessionId,
        id: approval.id,
        decision: "reject_once",
      });
    return this.gateway.call("cancel", { sessionId });
  }
  private async command(id: string, text: string, client: Context) {
    const [name, ...args] = text.trim().split(/\s+/);
    const sessionId = this.resolve(id).id;
    let result: unknown;
    switch (name) {
      case "/compact":
        await this.gateway.call("compact", { sessionId });
        result = {
          status:
            "Compaction requested. CoS retains the session identity and reports progress through its history.",
        };
        break;
      case "/cos-status":
        result = {
          state: await this.gateway.call("state", {
            sessionId,
            after: Number.MAX_SAFE_INTEGER,
          }),
          activity: await this.gateway.call("live", { sessionId }),
        };
        break;
      case "/cos-workers":
        result = {
          status: await this.gateway.call("workers", { sessionId }),
          reports: await this.gateway.call("reports", { sessionId }),
        };
        break;
      case "/cos-spawn":
        result = await this.gateway.call("worker-spawn", {
          sessionId,
          task: args.join(" "),
        });
        break;
      case "/cos-message":
        result = await this.gateway.call("worker-message", {
          sessionId,
          to: args.shift(),
          text: args.join(" "),
        });
        break;
      case "/cos-goal":
        result = await this.gateway.call("automation", {
          sessionId,
          mode: "goal",
          objective: args.join(" "),
        });
        break;
      case "/cos-loop":
        result = await this.gateway.call("automation", {
          sessionId,
          mode: "loop",
        });
        break;
      case "/cos-off":
        result = await this.gateway.call("automation", {
          sessionId,
          mode: "off",
        });
        break;
      default:
        throw new BridgeError(
          "unknown_command",
          "This CoS command is not supported.",
        );
    }
    const messageId = randomUUID();
    await this.update(
      client,
      id,
      this.version === 2
        ? {
            sessionUpdate: "agent_message",
            messageId,
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          }
        : {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: JSON.stringify(result, null, 2) },
          },
    );
    if (this.version === 2) {
      await this.update(client, id, {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
      });
      return { messageId };
    }
    return { stopReason: "end_turn" as const };
  }
}
export function apps(gateway?: Gateway) {
  const a1 = new Adapter(gateway, 1);
  const a2 = new Adapter(gateway, 2);
  const app1 = v1
    .agent()
    .onConnect((connection) => {
      a1.connectionSignal = connection.signal;
    })
    .onRequest(
      "initialize",
      ({ params }) => a1.initialize(params) as Promise<v1.InitializeResponse>,
    )
    .onRequest(
      "session/new",
      ({ params }) => a1.create(params.cwd) as Promise<v1.NewSessionResponse>,
    )
    .onRequest(
      "session/load",
      ({ params, client }) =>
        a1.load(
          params.sessionId,
          params.cwd,
          client,
        ) as Promise<v1.LoadSessionResponse>,
    )
    .onRequest(
      "session/resume",
      ({ params, client }) =>
        a1.load(
          params.sessionId,
          params.cwd,
          client,
          false,
        ) as Promise<v1.ResumeSessionResponse>,
    )
    .onRequest("session/list", ({ params }) =>
      a1.list(params.cursor ?? undefined, params.cwd ?? undefined),
    )
    .onRequest(
      "session/set_config_option",
      ({ params, client }) =>
        a1.set(
          params.sessionId,
          params.configId,
          String(params.value),
          client,
        ) as Promise<v1.SetSessionConfigOptionResponse>,
    )
    .onRequest("session/set_mode", async ({ params, client }) => {
      await a1.set(params.sessionId, "mode", params.modeId, client);
      return {};
    })
    .onRequest(
      "session/prompt",
      ({ params, client, signal }) =>
        a1.prompt(
          params.sessionId,
          params.prompt,
          params._meta,
          client,
          signal,
        ) as Promise<v1.PromptResponse>,
    )
    .onRequest("session/close", () => ({}))
    .onNotification("session/cancel", async ({ params }) => {
      await a1.cancel(params.sessionId);
    });
  const app2 = v2
    .agent()
    .onConnect((connection) => {
      a2.connectionSignal = connection.signal;
    })
    .onRequest(
      "initialize",
      ({ params }) => a2.initialize(params) as Promise<v2.InitializeResponse>,
    )
    .onRequest(
      "session/new",
      ({ params }) => a2.create(params.cwd) as Promise<v2.NewSessionResponse>,
    )
    .onRequest(
      "session/resume",
      ({ params, client }) =>
        a2.load(
          params.sessionId,
          params.cwd,
          client,
          params.replayFrom !== undefined,
        ) as Promise<v2.ResumeSessionResponse>,
    )
    .onRequest("session/list", ({ params }) =>
      a2.list(params.cursor ?? undefined, params.cwd ?? undefined),
    )
    .onRequest(
      "session/set_config_option",
      ({ params, client }) =>
        a2.set(
          params.sessionId,
          params.configId,
          String(params.value),
          client,
        ) as Promise<v2.SetSessionConfigOptionResponse>,
    )
    .onRequest(
      "session/prompt",
      ({ params, client, signal }) =>
        a2.prompt(
          params.sessionId,
          params.prompt,
          params._meta,
          client,
          signal,
        ) as Promise<v2.PromptResponse>,
    )
    .onRequest("session/close", () => ({}))
    .onNotification("session/cancel", async ({ params }) => {
      await a2.cancel(params.sessionId);
    });
  return { app1, app2, a1, a2 };
}
