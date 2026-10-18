import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  BridgeError,
  type Attachment,
  type Event,
  type Health,
  type Input,
  type Models,
  type Operation,
  type Session,
} from "./contracts.js";
import { Control } from "./control.js";
import { Store, fingerprint } from "./store.js";
import { stageStockFile, stageStockReference } from "./stock-staging.js";
import { recordedStockWorkers } from "./stock-workers.js";
import { isCoSContinuation } from "./continuation.js";
import {
  existingProject,
  existingProjectById,
  ProjectBindingRefusal,
} from "./compatibility.js";

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Stock and integration CoS cap one events page at 100 rows (MAX_EVENTS). */
const EVENT_PAGE = 100;
const encode = encodeURIComponent;
const normalized = (root: string) =>
  path
    .resolve(root)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
const terminal = (o: Operation) =>
  ["complete", "cancelled", "failed"].includes(o.phase);
export class Engine {
  readonly watches = new Map<string, AbortController>();
  readonly polling = new Set<string>();
  readonly busy = new Set<string>();
  health?: Health;
  closed = false;
  constructor(
    readonly store: Store,
    readonly control: Control,
  ) {}
  async ready() {
    return (this.health = await this.control.health());
  }
  session(id: string) {
    const s = this.store.session(id);
    if (!s)
      throw new BridgeError(
        "session_not_found",
        "This Chat on Steroids session was not found.",
      );
    return s;
  }
  async create(cwd: string, clientName?: string) {
    if (!path.isAbsolute(cwd))
      throw new BridgeError(
        "invalid_cwd",
        "The project directory must be absolute.",
      );
    const h = await this.ready();
    const legacy = h.integration?.tier === "existing-install";
    let project: { id: string; root: string } | undefined;
    if (legacy) {
      try {
        project = await existingProject(
          path.dirname(this.control.directory),
          cwd,
        );
      } catch (error) {
        if (!(error instanceof ProjectBindingRefusal)) throw error;
      }
    }
    const s = this.store.create(
      path.resolve(cwd),
      legacy ? "cos" : "supervised",
    );
    s.compatibility = legacy ? "existing-install" : "modern";
    if (project) s.projectId = project.id;
    // Stock CoS's "current model" has no known effort until the ChatGPT UI
    // is consulted. Its account model catalog instead exposes explicit,
    // selectable model/effort pairs. Set a real initial pair before T3
    // renders the controls so Thinking is offered before the first prompt.
    if (legacy && h.integration?.models) {
      try {
        const catalog = await this.models();
        const first =
          catalog.models.find((m) => m.efforts.includes("medium")) ??
          catalog.models.find((m) => m.efforts.length > 0);
        if (first) {
          s.model = first.id;
          s.effort = this.defaultEffort(first.efforts);
        }
      } catch {
        // A temporarily unavailable catalog must not prevent opening a chat.
        // Fall back to the explicitly labelled "current ChatGPT model".
      }
    }
    this.store.saveSession(s);
    return s;
  }
  async import(id: string, cwd: string) {
    const h = await this.ready();
    const known = this.store
      .sessions()
      .find((s) => s.id === id || s.cosId === id);
    if (known) {
      if (normalized(known.cwd) !== normalized(cwd))
        throw new BridgeError(
          "cwd_mismatch",
          "Resume this session in its original working directory.",
        );
      return known;
    }
    const detail = await this.control.request<{
      session: {
        id: string;
        title: string;
        conversationId: string | null;
        cwd?: string | null;
        projectId?: string | null;
      };
    }>("/v1/sessions/" + encode(id) + "?live=1");
    if (
      detail.session.cwd &&
      normalized(detail.session.cwd) !== normalized(cwd)
    )
      throw new BridgeError(
        "cwd_mismatch",
        "The CoS session belongs to another working directory.",
      );
    const legacy = h.integration?.tier === "existing-install";
    if (legacy && !detail.session.projectId)
      throw new BridgeError(
        "project_binding_unavailable",
        "This unregistered CoS conversation has no verified T3 working-directory mapping. Resume through its original T3 session.",
      );
    const project =
      legacy && detail.session.projectId
        ? await existingProject(
            path.dirname(this.control.directory),
            cwd,
            detail.session.projectId,
          )
        : undefined;
    const s = this.store.create(cwd, legacy ? "cos" : "supervised");
    s.compatibility = legacy ? "existing-install" : "modern";
    if (project) s.projectId = project.id;
    s.cosId = id;
    s.title = detail.session.title;
    s.conversationId = detail.session.conversationId;
    this.store.saveSession(s);
    await this.catchUp(s);
    return s;
  }
  async projects(cwd: string) {
    const h = this.health ?? (await this.ready());
    if (h.integration?.tier === "existing-install") {
      try {
        return (
          await existingProject(path.dirname(this.control.directory), cwd)
        ).id;
      } catch (error) {
        if (error instanceof ProjectBindingRefusal) return undefined;
        throw error;
      }
    }
    if (!h.routes.includes("/v1/projects"))
      throw new BridgeError(
        "runtime_update_required",
        "Update Chat on Steroids to the integration build before using project directories.",
      );
    const { projects } = await this.control.request<{
      projects: Array<{
        id: string;
        root: string | null;
        available: boolean;
        remote: boolean;
      }>;
    }>("/v1/projects");
    return projects.find(
      (p) =>
        p.available &&
        !p.remote &&
        p.root &&
        normalized(p.root) === normalized(cwd),
    )?.id;
  }
  async policy(s: Session, targetId?: string) {
    const h = this.health ?? (await this.ready());
    if (h.integration?.tier === "existing-install") {
      if (s.mode !== "cos" || s.compatibility !== "existing-install")
        throw new BridgeError(
          "permissions_unavailable",
          "This session requires runtime workspace/approval enforcement. Resume with the integration runtime; stock CoS cannot enforce T3 supervision.",
        );
      return;
    }
    if (!h.actions.routes.includes("POST /v1/sessions/{id}/approval-policy"))
      throw new BridgeError(
        "runtime_update_required",
        "Update Chat on Steroids to the integration build for safe tool approvals.",
      );
    await this.control.request(
      `/v1/sessions/${encode(targetId ?? s.cosId ?? s.id)}/approval-policy`,
      { mode: s.mode },
    );
  }
  private defaultEffort(efforts: string[]): string {
    return (
      ["medium", "high", "none"].find((effort) => efforts.includes(effort)) ??
      efforts[0]
    );
  }
  async set(
    id: string,
    values: Partial<Pick<Session, "model" | "effort" | "mode">>,
  ) {
    const s = this.session(id);
    if (s.activeInput)
      throw new BridgeError(
        "turn_active",
        "Change model or permissions after this turn finishes.",
      );
    if (values.mode) {
      await this.ready();
      await this.policy({ ...s, mode: values.mode });
      s.mode = values.mode;
    }
    if (values.model === "_cos_current") {
      s.model = null;
      s.effort = null;
    } else if (values.model !== undefined || values.effort !== undefined) {
      const models = await this.models();
      const choice = models.models.find(
        (m) => m.id === (values.model ?? s.model),
      );
      if (!choice)
        throw new BridgeError(
          "model_unavailable",
          "Refresh ChatGPT models in Chat on Steroids.",
        );
      s.model = choice.id;
      s.effort =
        values.effort ??
        (choice.efforts.includes(s.effort ?? "")
          ? s.effort
          : this.defaultEffort(choice.efforts));
      if (!s.effort || !choice.efforts.includes(s.effort))
        throw new BridgeError(
          "effort_unavailable",
          "This effort is unavailable for the selected model.",
        );
    }
    this.store.saveSession(s);
    return s;
  }
  async start(
    id: string,
    text: string,
    attachments: Attachment[],
    key?: string,
  ) {
    if (this.busy.has(id))
      throw new BridgeError(
        "turn_active",
        "A prompt is already being admitted.",
      );
    this.busy.add(id);
    try {
      return await this.startOnce(id, text, attachments, key);
    } finally {
      this.busy.delete(id);
    }
  }
  private async startOnce(
    id: string,
    text: string,
    attachments: Attachment[],
    key?: string,
  ) {
    const s = this.session(id);

    const hash = fingerprint({
      text,
      attachments,
      model: s.model,
      effort: s.effort,
      cwd: s.cwd,
    });
    // T3 preserves a user message ID across retries, but a failed native
    // session resume can produce a different ACP session. Fail closed instead
    // of admitting the same T3 instruction into a second ChatGPT session.
    // The local durable index stores only a hash of the caller's prompt ID.
    const keyHash = key ? fingerprint({ promptId: key }) : null;
    const owner = keyHash ? this.store.promptOwner(keyHash) : undefined;
    if (owner && owner !== id)
      throw new BridgeError(
        "outcome_unconfirmed",
        "This prompt ID belongs to another ACP session and may already have reached ChatGPT. Resume the original session before retrying; a new instruction needs a new message ID.",
      );
    const stable = key ? fingerprint({ session: id, key }).slice(0, 32) : null;
    const isNew = !s.cosId;
    const inputId = stable
      ? `${stable.slice(0, 8)}-${stable.slice(8, 12)}-4${stable.slice(13, 16)}-a${stable.slice(17, 20)}-${stable.slice(20)}`
      : isNew
        ? s.id
        : randomUUID();
    const prior = this.store.operation(inputId);
    if (prior) {
      if (prior.fingerprint !== hash)
        throw new BridgeError(
          "id_conflict",
          "The request ID already belongs to a different prompt.",
        );
      this.watch(s);
      return prior;
    }
    if (s.activeInput) {
      const existing = this.store.operation(s.activeInput);
      if (existing && !terminal(existing)) {
        await this.reconcile(s, existing);
        if (!terminal(existing))
          throw new BridgeError(
            "outcome_unconfirmed",
            `The previous input (${existing.id}) is still active or unconfirmed. Resume it before sending another prompt.`,
          );
      }
    }
    if (!text.trim() && !attachments.length)
      throw new BridgeError("empty_prompt", "The prompt is empty.");
    const h = await this.ready();
    if (h.integration?.tier === "existing-install" && attachments.length)
      throw new BridgeError(
        "unsupported_content",
        "Native CoS attachments require an upload API. Use adapter staging for stock CoS.",
      );
    if (!h.actions.enabled)
      throw new BridgeError(
        "actions_disabled",
        "Enable local control actions in Chat on Steroids Settings.",
      );
    const projectId = await this.projects(s.cwd);
    if (
      h.integration?.tier === "existing-install" &&
      s.projectId &&
      projectId !== s.projectId
    )
      throw new BridgeError(
        "project_binding_changed",
        "The CoS project binding changed. Resume after restoring its original project mapping.",
      );
    if (h.integration?.tier === "existing-install" && s.cosId) {
      const detail = await this.control.request<{
        session: { projectId?: string | null };
      }>(`/v1/sessions/${encode(s.cosId)}`);
      if ((detail.session.projectId ?? undefined) !== s.projectId)
        throw new BridgeError(
          "project_binding_changed",
          "The underlying CoS session moved to another project. No new input was submitted.",
        );
    }
    await this.policy(s, isNew ? inputId : undefined);
    // The real CoS approval boundary requires a live controller lease before
    // tools execute. Acquire it before admitting even the first prompt.
    if (s.mode === "supervised")
      await this.control.request(
        `/v1/approvals?sessionId=${encode(isNew ? inputId : s.cosId!)}`,
      );
    if (s.cosId) await this.catchUp(s);
    const o: Operation = {
      id: inputId,
      sessionId: id,
      fingerprint: hash,
      phase: "prepared",
      turnId: null,
      delivery: "pending",
      error: null,
      baseline: s.seq,
    };
    s.activeInput = o.id;
    s.lastInput = o.id;
    if (!s.cosId) s.cosId = o.id;
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      if (keyHash && this.store.claimPromptKey(keyHash, id) !== id)
        throw new BridgeError(
          "outcome_unconfirmed",
          "This prompt ID was admitted by another ACP session. Resume the original session before retrying.",
        );
      this.store.saveOperation(o);
      this.store.saveSession(s);
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    try {
      const stockUnbound =
        h.integration?.tier === "existing-install" && !s.projectId;
      const textForCoS = stockUnbound
        ? "[T3 session context: T3 supplied working directory " +
          JSON.stringify(s.cwd) +
          ". This folder is not registered as a CoS project. When the user requests filesystem work, use this absolute path only if CoS tools permit it; ordinary projectless chat requires no file operations.]\n\n" +
          text.trim()
        : text.trim();
      const result = await this.control.request<{ input: Input }>(
        "/v1/inputs",
        {
          id: o.id,
          ...(!isNew ? { sessionId: s.cosId } : {}),
          ...(isNew && s.projectId ? { projectId: s.projectId } : {}),
          ...(h.integration?.tier === "existing-install" ? {} : { cwd: s.cwd }),
          text: textForCoS || "[Attachment]",
          ...(attachments.length ? { attachments } : {}),
          ...(s.model ? { model: s.model, reasoningEffort: s.effort } : {}),
        },
      );
      o.phase = "admitted";
      this.acceptInput(s, o, result.input);
    } catch (error) {
      o.phase = "uncertain";
      o.error = error instanceof BridgeError ? error.code : "connection_lost";
      if (
        error instanceof BridgeError &&
        [
          "invalid_body",
          "actions_disabled",
          "session_not_found",
          "cwd_not_allowed",
          "cwd_mismatch",
          "project_not_found",
          "id_conflict",
          "chat_blocked",
          "no_chat",
          "would_interrupt",
          "model_unknown",
          "models_unknown",
          "effort_unavailable",
        ].includes(error.code)
      ) {
        o.phase = "failed";
        s.activeInput = null;
        if (isNew) s.cosId = null;
        this.store.saveSession(s);
      }
      this.store.saveOperation(o);
      if (o.phase === "failed") throw error;
    }
    this.watch(s);
    return o;
  }
  private acceptInput(s: Session, o: Operation, input: Input) {
    o.delivery = input.delivery;
    s.conversationId = input.conversationId ?? s.conversationId;
    s.cosId = input.deliveredSessionId ?? input.sessionId ?? s.cosId;
    if (input.delivery === "not_sent") {
      o.phase = input.state === "cancelled" ? "cancelled" : "failed";
      o.error = input.error ?? input.state;
      s.activeInput = null;
    }
    this.store.saveOperation(o);
    this.store.saveSession(s);
  }
  async reconcile(s: Session, o: Operation) {
    try {
      const h = this.health ?? (await this.ready());
      const input =
        h.integration?.tier === "existing-install"
          ? (
              await this.control.request<{ inputs: Input[] }>(
                "/v1/inputs?limit=500",
              )
            ).inputs.find((row) => row.id === o.id)
          : (
              await this.control.request<{ input: Input }>(
                `/v1/inputs/${encode(o.id)}`,
              )
            ).input;
      if (!input)
        throw new BridgeError(
          "input_not_found",
          "The input is outside CoS's retained outbox window; absence is not proof of non-delivery.",
        );
      this.acceptInput(s, o, input);
      if (o.phase === "uncertain" && input.delivery !== "unconfirmed")
        o.phase = "admitted";
      this.store.saveOperation(o);
    } catch (error) {
      if (
        error instanceof BridgeError &&
        error.code === "input_not_found" &&
        o.phase === "prepared"
      ) {
        o.phase = "uncertain";
        this.store.saveOperation(o);
      } /* Absence is not proof that an interrupted write was never admitted. */
    }
    // Durable event receipts can prove completion after the bounded stock
    // outbox window no longer includes this input; they never cause resends.
    const user = this.store.inputEvent(s.id, o.id);
    if (user) this.observe(s, o, user);
    if (o.turnId && !this.store.turnStarted(s.id, o.turnId)) o.turnId = null;
    if (user && !o.turnId) {
      const anchor = this.store.firstInputEvent(s.id, o.id) ?? user;
      const start = this.store.turnStart(s.id, anchor.seq);
      if (start) this.observe(s, o, start);
    }
    if (o.turnId) {
      const end = this.store.turnEnd(s.id, o.turnId, o.baseline);
      if (end) this.observe(s, o, end);
    }
  }
  private observe(s: Session, o: Operation, e: Event) {
    if (e.seq <= o.baseline) return;
    // CoS generates a new user message during long tasks, then interrupts the
    // older turn and starts a fresh one. T3 still owns the original user input.
    if (isCoSContinuation(e) && e.inputId !== o.id && o.delivery === "sent") {
      o.continuationQueued = true;
      if (o.turnId)
        o.continuationTurnIds = [
          ...new Set([...(o.continuationTurnIds ?? []), o.turnId]),
        ];
      this.store.saveOperation(o);
    }
    if (e.kind === "turn_start" && e.turnId && o.awaitingContinuation) {
      o.turnId = e.turnId;
      o.continuationTurnIds = [
        ...new Set([...(o.continuationTurnIds ?? []), e.turnId]),
      ];
      o.awaitingContinuation = false;
      this.store.saveOperation(o);
    }
    // A turn link is evidence only while the recorded stream actually started
    // that turn. Stock revises a user message's own marker as a page-side
    // boundary hint (it can even name the native message id), so a persisted
    // link that no recorded turn_start backs is a marker, not a turn.
    if (o.turnId && !this.store.turnStarted(s.id, o.turnId)) o.turnId = null;
    if (e.kind === "user_message" && e.inputId === o.id) {
      // Only a message marker that names a recorded turn may link; the marker
      // on a confirmed browser message is a boundary hint, never the turn.
      if (e.turnId && this.store.turnStarted(s.id, e.turnId))
        o.turnId = e.turnId;
      // Stock CoS records "confirmed" once native delivery is proven and
      // "offered" while a handout still awaits its exact receipt; only the
      // former is delivery evidence.
      if (e.inputDelivery === "sent" || e.inputDelivery === "confirmed")
        o.delivery = "sent";
      // A proof that lands after the turn began still links the turn this
      // session recorded, exactly as reconciliation does after a restart.
      if (!o.turnId && o.delivery === "sent") {
        const anchor = this.store.firstInputEvent(s.id, o.id) ?? e;
        const start = this.store.turnStart(s.id, anchor.seq);
        if (start) this.observe(s, o, start);
      }
    }
    if (
      e.kind === "turn_start" &&
      e.turnId &&
      !o.turnId &&
      o.delivery === "sent"
    ) {
      // The recorded stream names the turn on turn_start, not on the user
      // message. Link it only once this exact input is proven delivered and
      // its own user message is on record; an "offered" handout never links.
      const source = this.store.firstInputEvent(s.id, o.id);
      if (
        source &&
        (source.inputDelivery === undefined ||
          source.inputDelivery === "sent" ||
          source.inputDelivery === "confirmed")
      )
        o.turnId = e.turnId;
    }
    if ((e.kind === "user_message" || e.kind === "turn_start") && o.turnId) {
      const end = this.store.turnEnd(s.id, o.turnId, o.baseline);
      if (end) this.observe(s, o, end);
    }
    if (
      e.kind === "turn_end" &&
      o.turnId &&
      e.turnId === o.turnId &&
      o.delivery === "sent" &&
      e.outcome &&
      e.outcome !== "unknown"
    ) {
      if (e.outcome === "interrupted" && o.continuationQueued) {
        o.continuationQueued = false;
        o.awaitingContinuation = true;
        this.store.saveOperation(o);
        return;
      }
      if (e.outcome === "interrupted" && o.awaitingContinuation) return;
      o.phase =
        e.outcome === "completed"
          ? "complete"
          : ["stopped", "interrupted", "cancelled"].includes(e.outcome)
            ? "cancelled"
            : "failed";
      if (o.phase === "failed") o.error = `turn_${e.outcome}`;
      s.activeInput = null;
      this.store.saveSession(s);
    }
    this.store.saveOperation(o);
  }
  receive(s: Session, e: Event) {
    this.store.append(s, e);
    if (s.activeInput) {
      const o = this.store.operation(s.activeInput);
      if (o) this.observe(s, o, e);
    }
  }
  async catchUp(s: Session) {
    for (let i = 0; i < 20; i++) {
      const page = await this.control.request<{
        events: Event[];
        nextFrom: number;
      }>(
        `/v1/sessions/${encode(s.cosId!)}/events?from=${s.seq + 1}&limit=${EVENT_PAGE}`,
      );
      for (const e of page.events.sort((a, b) => a.seq - b.seq))
        this.receive(s, e);
      if (page.events.length < EVENT_PAGE) break;
    }
  }
  watch(s: Session) {
    if (!s.cosId || this.polling.has(s.id) || this.closed) return;
    this.polling.add(s.id);
    void this.follow(s.id).finally(() => this.polling.delete(s.id));
  }
  private async follow(id: string) {
    let failures = 0;
    while (!this.closed) {
      const s = this.session(id);
      if (!s.activeInput) return;
      const op = this.store.operation(s.activeInput)!;
      if (terminal(op)) return;
      try {
        await this.reconcile(s, op);
        if (terminal(op)) return;
        if (this.watches.size < 3) {
          const abort = new AbortController();
          this.watches.set(id, abort);
          const reconcile = setInterval(() => {
            const current = this.session(id);
            if (current.activeInput)
              void this.reconcile(
                current,
                this.store.operation(current.activeInput)!,
              ).catch(() => undefined);
          }, 5000);
          try {
            for await (const event of this.control.stream(
              s.cosId!,
              s.seq,
              abort.signal,
            )) {
              this.receive(s, event);
              if (!s.activeInput) {
                abort.abort();
                break;
              }
            }
          } finally {
            clearInterval(reconcile);
            this.watches.delete(id);
          }
        } else {
          await this.catchUp(s);
          await sleep(3000);
        }
        failures = 0;
      } catch {
        failures++;
        await sleep(Math.min(15000, 1000 * 2 ** Math.min(failures, 4)));
      }
    }
  }
  async state(id: string, after: number) {
    const s = this.session(id);
    if (s.activeInput) this.watch(s);
    return {
      session: s,
      operation:
        (s.activeInput ?? s.lastInput)
          ? this.store.operation((s.activeInput ?? s.lastInput)!)
          : undefined,
      events: this.store.events(id, after),
    };
  }
  async cancel(id: string) {
    const s = this.session(id);
    if (!s.activeInput) return { confirmed: true };
    const o = this.store.operation(s.activeInput)!;
    await this.reconcile(s, o);
    if (terminal(o)) return { confirmed: true };
    if (o.delivery === "pending") {
      try {
        const { input } = await this.control.request<{ input: Input }>(
          `/v1/inputs/${encode(o.id)}/cancel`,
          {},
        );
        this.acceptInput(s, o, input);
        if (input.delivery === "not_sent") return { confirmed: true };
      } catch (error) {
        if (!(error instanceof BridgeError) || error.code !== "not_cancellable")
          throw error;
      }
    }
    await this.catchUp(s);
    const current = this.store.operation(o.id)!;
    if (!current.turnId)
      throw new BridgeError(
        "outcome_unconfirmed",
        "The exact turn is not yet known. Its input is retained; cancellation has not been confirmed.",
      );
    await this.control.request(`/v1/sessions/${encode(s.cosId!)}/stop`, {
      turnId: current.turnId,
    });
    return { confirmed: false, turnId: current.turnId };
  }
  async dispatch(method: string, p: Record<string, unknown> = {}) {
    const id = String(p.sessionId ?? "");
    switch (method) {
      case "health":
        return this.ready();
      case "models":
        return this.models();
      case "new":
        return this.create(
          String(p.cwd),
          typeof p.clientName === "string" ? p.clientName : undefined,
        );
      case "load":
        return this.import(id, String(p.cwd));
      case "list": {
        const health = await this.ready();
        const remote = await this.control.request<{
          sessions: Array<{
            id: string;
            title: string;
            updatedAt: number;
            projectId?: string;
          }>;
          nextCursor: string | null;
        }>(
          `/v1/sessions?limit=50${p.cursor ? "&cursor=" + encode(String(p.cursor)) : ""}`,
        );
        if (health.integration?.tier === "existing-install") {
          const mappings = new Map<string, string>();
          const ids = [
            ...new Set(
              remote.sessions.flatMap((s) =>
                s.projectId ? [s.projectId] : [],
              ),
            ),
          ];
          for (const projectId of ids) {
            const project = await existingProjectById(
              path.dirname(this.control.directory),
              projectId,
            );
            if (project) mappings.set(projectId, project.root);
          }
          return {
            ...remote,
            sessions: remote.sessions.map((s) => ({
              ...s,
              cwd: s.projectId
                ? (mappings.get(s.projectId) ?? null)
                : (this.store
                    .sessions()
                    .find(
                      (known) =>
                        known.compatibility === "existing-install" &&
                        !known.projectId &&
                        known.cosId === s.id,
                    )?.cwd ?? null),
            })),
          };
        }
        return remote;
      }
      case "set":
        return this.set(id, p as Partial<Session>);
      case "start":
        return this.start(
          id,
          String(p.text ?? ""),
          (p.attachments ?? []) as Attachment[],
          typeof p.key === "string" ? p.key : undefined,
        );
      case "state":
        return this.state(id, Number(p.after ?? 0));
      case "cancel":
        return this.cancel(id);
      case "stage-reference": {
        const s = this.session(id);
        const h = await this.ready();
        if (h.integration?.tier !== "existing-install")
          throw new BridgeError(
            "capability_unavailable",
            "Stock staging is only available for stock CoS.",
          );
        return stageStockReference(
          path.dirname(this.control.directory),
          s.cwd,
          String(p.uri ?? ""),
        );
      }
      case "stage": {
        const s = this.session(id);
        const h = await this.ready();
        if (h.integration?.tier !== "existing-install")
          throw new BridgeError(
            "capability_unavailable",
            "Stock staging is only available for stock CoS.",
          );
        return stageStockFile(path.dirname(this.control.directory), s.cwd, {
          data: String(p.data ?? ""),
          name: typeof p.name === "string" ? p.name : undefined,
          mimeType: typeof p.mimeType === "string" ? p.mimeType : undefined,
        });
      }
      case "upload":
        if ((await this.ready()).integration?.attachments === false)
          throw new BridgeError(
            "unsupported_content",
            "This CoS build has no attachment ingress route. Attach files directly in CoS.",
          );
        return this.control.request("/v1/attachments", {
          name: p.name,
          data: p.data,
        });
      case "asset": {
        if ((await this.ready()).integration?.assets === false)
          throw new BridgeError(
            "capability_unavailable",
            "This CoS build has no supported session asset API. View the original media in CoS.",
          );
        const s = this.session(id);
        if (!s.cosId)
          throw new BridgeError(
            "session_not_started",
            "No CoS session is available for this asset.",
          );
        const assetId = String(p.assetId ?? "");
        if (!/^[0-9a-f]{8,64}\.(?:png|jpg|bin)$/.test(assetId))
          throw new BridgeError("invalid_asset", "Unsupported image asset ID.");
        const workerId = p.workerSessionId;
        let target = s.cosId;
        if (typeof workerId === "string" && workerId !== s.cosId) {
          const { workers } = await this.control.request<{
            workers: Array<{ sessionId?: string | null }>;
          }>(`/v1/sessions/${encode(s.cosId)}/workers`);
          if (!workers.some((worker) => worker.sessionId === workerId))
            throw new BridgeError(
              "worker_not_in_session",
              "This asset belongs to a different session.",
            );
          target = workerId;
        }
        return this.control.request(
          `/v1/sessions/${encode(target)}/assets/${encode(assetId)}`,
        );
      }
      case "compact": {
        if ((await this.ready()).integration?.compact === false)
          throw new BridgeError(
            "capability_unavailable",
            "Compaction is available in CoS directly; this build has no control API route.",
          );
        const s = this.session(id);
        if (!s.cosId)
          throw new BridgeError(
            "session_not_started",
            "Send a prompt before compacting this conversation.",
          );
        return this.control.request(
          `/v1/sessions/${encode(s.cosId)}/compact`,
          {},
        );
      }
      case "approvals": {
        const s = this.session(id);
        if ((await this.ready()).integration?.permissions === "cos-only") {
          if (s.mode !== "cos")
            throw new BridgeError(
              "permissions_unavailable",
              "Stock CoS cannot enforce T3 supervision.",
            );
          return { mode: "cos", approvals: [] };
        }
        return this.control.request(
          `/v1/approvals?sessionId=${encode(s.cosId ?? s.id)}`,
        );
      }
      case "resolve": {
        const s = this.session(id);
        return this.control.request(
          `/v1/approvals/${encode(String(p.id))}/resolve`,
          { sessionId: s.cosId ?? s.id, decision: p.decision },
        );
      }
      case "live": {
        const s = this.session(id);
        if (!s.cosId) return { live: null };
        const h = await this.ready();
        if (!h.routes.includes("/v1/sessions/{id}")) return { live: null };
        const detail = await this.control.request<{
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
        }>("/v1/sessions/" + encode(s.cosId) + "?live=1");
        return { live: detail.live ?? null };
      }
      case "workers": {
        const s = this.session(id);
        const h = await this.ready();
        if (
          h.integration?.sessionWorkers ||
          s.compatibility !== "existing-install"
        )
          return this.control.request(
            "/v1/sessions/" + encode(s.cosId ?? s.id) + "/workers",
          );
        if (s.cosId) {
          let live: Array<{
            id: string;
            sessionId?: string | null;
            label: string;
            state: string;
            runId?: string | null;
          }> = [];
          if (h.routes.includes("/v1/workers/{ownerId}")) {
            try {
              const response = await this.control.request<{
                workers: typeof live;
              }>("/v1/workers/" + encode(s.cosId));
              live = Array.isArray(response.workers) ? response.workers : [];
            } catch (error) {
              if (!(error instanceof BridgeError) || error.code !== "not_found")
                throw error;
            }
          }
          const history = await recordedStockWorkers(
            (route) => this.control.request(route),
            s.cosId,
          );
          const ids = new Set(
            live.map((worker) => worker.sessionId).filter(Boolean),
          );
          return {
            workers: [
              ...live,
              ...history.filter((worker) => !ids.has(worker.sessionId)),
            ],
          };
        }
        return { workers: [] };
      }
      case "reports": {
        const s = this.session(id);
        const h = await this.ready();
        if (
          h.integration?.sessionWorkers ||
          s.compatibility !== "existing-install"
        )
          return this.control.request(
            "/v1/sessions/" + encode(s.cosId ?? s.id) + "/workers/reports",
          );
        if (h.routes.includes("/v1/workers/{ownerId}/reports") && s.cosId) {
          try {
            return await this.control.request(
              "/v1/workers/" + encode(s.cosId) + "/reports",
            );
          } catch (error) {
            if (error instanceof BridgeError && error.code === "not_found")
              return { reports: [] };
            throw error;
          }
        }
        return { reports: [], unavailable: true };
      }
      case "worker-events": {
        const s = this.session(id);
        if (!s.cosId)
          throw new BridgeError(
            "session_not_started",
            "This session has not opened a CoS conversation.",
          );
        const childId = String(p.workerSessionId ?? "");
        const after = Number(p.after ?? 0);
        if (!Number.isSafeInteger(after) || after < 0)
          throw new BridgeError(
            "invalid_cursor",
            "Invalid worker event cursor.",
          );
        const response = (await this.dispatch("workers", {
          sessionId: s.id,
        })) as {
          workers: Array<{ sessionId?: string | null }>;
        };
        if (!response.workers.some((worker) => worker.sessionId === childId))
          throw new BridgeError(
            "worker_not_in_session",
            "This worker does not belong to the requested CoS session.",
          );
        return this.control.request(
          "/v1/sessions/" +
            encode(childId) +
            "/events?from=" +
            (after + 1) +
            "&limit=" +
            EVENT_PAGE,
        );
      }
      case "worker-message": {
        if ((await this.ready()).integration?.sessionWorkers === false)
          throw new BridgeError(
            "capability_unavailable",
            "Session-scoped worker messaging requires the integration runtime. Use CoS directly.",
          );
        const s = this.session(id);
        return this.control.request(
          `/v1/sessions/${encode(s.cosId ?? s.id)}/workers/message`,
          { messages: [{ to: p.to, text: p.text }] },
        );
      }
      case "worker-spawn": {
        if ((await this.ready()).integration?.sessionWorkers === false)
          throw new BridgeError(
            "capability_unavailable",
            "Session-scoped worker creation requires the integration runtime. Use CoS directly.",
          );
        const s = this.session(id);
        return this.control.request(
          `/v1/sessions/${encode(s.cosId ?? s.id)}/workers/spawn`,
          { workers: [{ task: p.task }] },
        );
      }
      case "automation": {
        if ((await this.ready()).integration?.automation === false)
          throw new BridgeError(
            "capability_unavailable",
            "This CoS build has no automation control API. Use Goal/Loop in CoS directly.",
          );
        const s = this.session(id);
        if (!s.cosId)
          throw new BridgeError(
            "session_not_started",
            "Send the first prompt before setting automation.",
          );
        return this.control.request(
          `/v1/sessions/${encode(s.cosId)}/automation`,
          { mode: p.mode, ...(p.objective ? { objective: p.objective } : {}) },
        );
      }
      default:
        throw new BridgeError("unknown_method", "Unknown bridge operation.");
    }
  }
  close() {
    this.closed = true;
    for (const abort of this.watches.values()) abort.abort();
  }
  async models(): Promise<Models> {
    const h = await this.ready();
    if (h.integration?.models === false)
      return { state: "current-model-only", models: [] };
    const catalog = await this.control.request<Models>("/v1/models");
    // The catalog is a negotiated capability: an unrecognized shape falls
    // back to the safe current-selection view instead of leaking through.
    const valid =
      catalog !== null &&
      typeof catalog.state === "string" &&
      Array.isArray(catalog.models) &&
      catalog.models.length <= 100 &&
      catalog.models.every(
        (m) =>
          typeof m?.id === "string" &&
          m.id.length > 0 &&
          m.id.length <= 80 &&
          typeof m.label === "string" &&
          Array.isArray(m.efforts) &&
          m.efforts.every(
            (effort) => typeof effort === "string" && effort.length > 0,
          ),
      );
    return valid ? catalog : { state: "unavailable", models: [] };
  }
}
