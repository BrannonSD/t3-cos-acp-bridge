import { test } from "node:test";
import assert from "node:assert/strict";
import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { Adapter, apps, type Gateway } from "../src/adapter.js";
import { BridgeError, type Session, type Operation } from "../src/contracts.js";
class FakeGateway implements Gateway {
  lastText?: string;
  readonly s: Session = {
    id: "00000000-0000-4000-a000-000000000001",
    cosId: "00000000-0000-4000-a000-000000000002",
    cwd: process.cwd(),
    model: "account-model",
    effort: "max",
    mode: "supervised",
    seq: 0,
    title: "ChatGPT test",
    updatedAt: Date.now(),
    activeInput: null,
    conversationId: "real-conversation",
  };
  readonly operation: Operation = {
    id: "00000000-0000-4000-a000-000000000003",
    sessionId: this.s.id,
    fingerprint: "test",
    phase: "complete",
    turnId: "real-turn",
    delivery: "sent",
    error: null,
    baseline: 0,
  };
  resolved: string[] = [];
  started = false;
  workerStates = ["done"];
  workerReads = 0;
  workerFailures = 0;
  imageEnabled = false;
  imageInvalid = false;
  async call<T>(method: string, p: Record<string, unknown> = {}): Promise<T> {
    let result: unknown;
    switch (method) {
      case "health":
        result = {
          routes: ["/v1/models"],
          actions: { routes: ["POST /v1/attachments"] },
        };
        break;
      case "models":
        result = {
          state: "ready",
          models: [
            { id: "account-model", label: "Account model", efforts: ["max"] },
          ],
        };
        break;
      case "new":
      case "load":
        result = { ...this.s };
        break;
      case "set":
        result = { ...this.s, ...p };
        break;
      case "start":
        this.lastText = String(p.text);
        this.started = true;
        result = this.operation;
        break;
      case "state":
        result = {
          session: { ...this.s },
          operation: this.started ? this.operation : undefined,
          events:
            this.started && Number(p.after ?? 0) === 0
              ? [
                  {
                    seq: 1,
                    position: 0,
                    kind: "assistant_message",
                    messageId: "assistant-real",
                    message: { text: "A streamed answer" },
                  },
                  {
                    seq: 2,
                    position: 0,
                    kind: "assistant_message",
                    messageId: "assistant-real",
                    message: { text: "A revised answer" },
                  },
                  {
                    seq: 3,
                    position: 1,
                    kind: "tool_call",
                    tool: {
                      callId: "tool-real",
                      name: "read_file",
                      outcome: "ok",
                      summary: { title: "Read file", kind: "read" },
                      args: { text: "file.txt" },
                      result: { text: "file content" },
                      changes: [],
                    },
                  },
                  ...(this.imageEnabled
                    ? [
                        {
                          seq: 4,
                          position: 2,
                          kind: "native_image",
                          assets: [
                            {
                              id: "deadbeef.png",
                              mimeType: "image/png",
                              bytes: 68,
                            },
                          ],
                        },
                      ]
                    : []),
                ]
              : [],
        };
        break;
      case "approvals":
        result = { approvals: [] };
        break;
      case "worker-events":
        result = {
          events:
            Number(p.after ?? 0) > 0
              ? []
              : [
                  {
                    seq: 1,
                    position: 0,
                    kind: "assistant_message",
                    messageId: "worker-message",
                    message: { text: "Child result" },
                  },
                ],
        };
        break;
      case "workers":
        this.workerReads++;
        if (this.workerFailures > 0) {
          this.workerFailures--;
          throw new BridgeError(
            "process_identity_unavailable",
            "The existing CoS process identity could not be verified.",
          );
        }
        result = {
          workers: [
            {
              id: "worker-1",
              label: "Worker",
              state:
                this.workerStates[
                  Math.min(this.workerReads - 1, this.workerStates.length - 1)
                ],
              sessionId: "child-cos-id",
            },
          ],
        };
        break;
      case "asset":
        result = {
          asset: {
            id: this.imageInvalid ? "not-requested.png" : String(p.assetId),
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==",
          },
        };
        break;
      case "upload":
        result = {
          attachment: {
            id: "asset-1",
            name: "image.png",
            size: 3,
            mimeType: "image/png",
          },
        };
        break;
      case "cancel":
        result = { confirmed: true };
        break;
      default:
        throw new Error(method);
    }
    return result as T;
  }
}
test("T3 context keeps CoS tool ownership and suppresses delivery echoes without losing assistant/tool updates", async () => {
  class EchoGateway extends FakeGateway {
    override async call<T>(
      method: string,
      p: Record<string, unknown> = {},
    ): Promise<T> {
      const result = await super.call<T>(method, p);
      if (method === "state" && this.started && Number(p.after ?? 0) === 0) {
        const state = result as { events: unknown[] };
        state.events.unshift({
          seq: 0,
          position: 0,
          kind: "user_message",
          messageId: "echo",
          inputId: this.operation.id,
          inputDelivery: "confirmed",
          message: { text: this.lastText },
        });
      }
      return result;
    }
  }
  for (const version of [1, 2] as const) {
    const gateway = new EchoGateway();
    const adapter = new Adapter(gateway, version);
    await adapter.initialize(
      version === 1
        ? { clientInfo: { name: "t3-code" } }
        : { info: { name: "t3-code" } },
    );
    const s = await adapter.create(process.cwd());
    const updates: Array<{ sessionUpdate: string }> = [];
    const client = {
      notify: async (_method: string, params: any) => {
        updates.push(params.update);
      },
      request: async <T>() => ({}) as T,
    };
    await adapter.prompt(
      s.sessionId,
      [
        {
          type: "text",
          text: "<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nUse preview_open.\n</t3_code_instructions>\n\n<user_request>\nRead a file.\n</user_request>",
        },
      ],
      undefined,
      client,
      new AbortController().signal,
    );
    if (version === 2) await adapter.active.get(s.sessionId);
    assert(gateway.lastText?.includes("use CoS browser tools"));
    assert(!gateway.lastText?.includes("preview_open"));
    assert(
      !updates.some((u) =>
        ["agent_message", "agent_message_chunk"].includes(u.sessionUpdate),
      ),
      "child messages must not appear as the parent reply in generic T3",
    );
    assert(
      updates.some((u) =>
        ["tool_call", "tool_call_update"].includes(u.sessionUpdate),
      ),
    );
    assert(
      !updates.some((u) =>
        ["user_message", "user_message_chunk"].includes(u.sessionUpdate),
      ),
    );
  }
});
test("official ACP v1 client creates, configures, streams tools/revisions and completes exact prompt", async () => {
  const gateway = new FakeGateway();
  const { app1 } = apps(gateway);
  const updates: v1.SessionUpdate[] = [];
  const client = v1.client().onNotification("session/update", ({ params }) => {
    updates.push(params.update);
  });
  await client.connectWith(app1, async (ctx) => {
    const init = await ctx.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "t3-fixture", version: "1" },
    });
    assert.equal(init.agentInfo?.name, "chat-on-steroids");
    const session = await ctx.request("session/new", {
      cwd: process.cwd(),
      mcpServers: [],
    });
    assert.equal(session.sessionId, gateway.s.id);
    assert.equal(
      session.configOptions?.find((o) => o.id === "mode")?.currentValue,
      "supervised",
    );
    const response = await ctx.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Do work" }],
    });
    assert.equal(response.stopReason, "end_turn");
    assert(updates.some((u) => u.sessionUpdate === "tool_call"));
    assert(
      updates.some(
        (u) =>
          u.sessionUpdate === "agent_message_chunk" &&
          u.content.type === "text" &&
          u.content.text.includes("Response revised"),
      ),
    );
  });
});
test("official ACP v2 client acknowledges input separately from foreground completion and replaces revised messages", async () => {
  const gateway = new FakeGateway();
  const { app2 } = apps(gateway);
  const updates: v2.SessionUpdate[] = [];
  let finish!: () => void;
  const ended = new Promise<void>((resolve) => (finish = resolve));
  const client = v2.client().onNotification("session/update", ({ params }) => {
    updates.push(params.update);
    if (
      params.update.sessionUpdate === "state_update" &&
      params.update.state === "idle"
    )
      finish();
  });
  await client.connectWith(app2, async (ctx) => {
    const init = await ctx.request("initialize", {
      protocolVersion: 2,
      info: { name: "t3-fixture", version: "1" },
      capabilities: {},
    });
    assert.equal(init.info.name, "chat-on-steroids");
    assert(init.capabilities?.session);
    const session = await ctx.request("session/new", { cwd: process.cwd() });
    assert(session.configOptions?.every((o) => "configId" in o));
    const response = await ctx.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Do real ChatGPT work" }],
    });
    assert.equal(response.messageId, gateway.operation.id);
    await ended;
    const messages = updates.filter(
      (u) =>
        u.sessionUpdate === "agent_message" &&
        !u._meta?.["chat-on-steroids/workerContext"],
    );
    assert.equal(messages.length, 2);
    assert.equal(messages[0].messageId, messages[1].messageId);
    assert(updates.some((u) => u.sessionUpdate === "tool_call_update"));
    assert(
      updates.some(
        (u) =>
          u.sessionUpdate === "agent_message" &&
          u._meta?.["chat-on-steroids/workerContext"]?.sessionId ===
            "child-cos-id",
      ),
    );
    assert(updates.some((u) => u.sessionUpdate === "user_message"));
    assert(
      updates.some(
        (u) => u.sessionUpdate === "state_update" && u.state === "running",
      ),
    );
  });
});
test("attachments use CoS staging owner, and unsupported content is rejected before admission", async () => {
  const gateway = new FakeGateway();
  const { a1 } = apps(gateway);
  const result = await a1.content([
    { type: "image", data: "YWJj", mimeType: "image/png" },
  ]);
  assert.equal(result.attachments[0].id, "asset-1");
  await assert.rejects(a1.content([{ type: "audio", data: "YWJj" }]), {
    code: "unsupported_content",
  });
  assert.equal(gateway.started, false);
});

test("ACP v2 follows a running child after its parent turn settles", async () => {
  const gateway = new FakeGateway();
  gateway.workerStates = ["active", "sleeping"];
  const { app2 } = apps(gateway);
  let settle!: () => void;
  const idle = new Promise<void>((resolve) => (settle = resolve));
  let sawActive = false;
  let sawWaiting = false;
  const client = v2.client().onNotification("session/update", ({ params }) => {
    const update = params.update;
    if (update.sessionUpdate === "tool_call_update") {
      const metadata = update._meta?.["chat-on-steroids/worker"] as
        | { status?: string }
        | undefined;
      if (metadata?.status === "running") sawActive = true;
      if (metadata?.status === "waiting") sawWaiting = true;
    }
    if (update.sessionUpdate === "state_update" && update.state === "idle")
      settle();
  });
  await client.connectWith(app2, async (ctx) => {
    await ctx.request("initialize", {
      protocolVersion: 2,
      info: { name: "t3-fixture", version: "1" },
      capabilities: {},
    });
    const session = await ctx.request("session/new", { cwd: process.cwd() });
    await ctx.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Delegate work" }],
    });
    await new Promise((done) => setTimeout(done, 200));
    assert(sawActive, "T3 observes the live worker lifecycle");
    assert.equal(
      gateway.workerReads,
      1,
      "parent did not settle before child status",
    );
    await idle;
    assert(sawWaiting, "worker parked without losing lifecycle updates");
    assert(gateway.workerReads >= 2);
  });
});

test("a transient control refresh failure never abandons a running turn", async () => {
  const gateway = new FakeGateway();
  gateway.workerFailures = 1;
  const { app2 } = apps(gateway);
  const updates: v2.SessionUpdate[] = [];
  let settle!: () => void;
  const idle = new Promise<void>((resolve) => (settle = resolve));
  const client = v2.client().onNotification("session/update", ({ params }) => {
    updates.push(params.update);
    if (
      params.update.sessionUpdate === "state_update" &&
      params.update.state === "idle"
    )
      settle();
  });
  await client.connectWith(app2, async (ctx) => {
    await ctx.request("initialize", {
      protocolVersion: 2,
      info: { name: "t3-fixture", version: "1" },
      capabilities: {},
    });
    const session = await ctx.request("session/new", { cwd: process.cwd() });
    const response = await ctx.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Do real ChatGPT work" }],
    });
    assert.equal(response.messageId, gateway.operation.id);
    const settled = await Promise.race([
      idle.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
    ]);
    assert(settled, "the turn still settles after a control refresh failure");
    assert.equal(
      gateway.workerReads,
      1,
      "the failing control call was attempted once",
    );
    assert(
      updates.some(
        (u) =>
          u.sessionUpdate === "agent_message" &&
          !u._meta?.["chat-on-steroids/workerContext"],
      ),
      "streamed output survives the control failure",
    );
  });
});

test("both ACP versions return vetted disabled-control request errors without admitting a prompt", async () => {
  let calls = 0;
  const gateway: Gateway = {
    async call(method) {
      calls++;
      assert.equal(method, "health", "no CoS input/action route is called");
      throw new BridgeError(
        "control_unavailable",
        "Chat on Steroids is unavailable. Open it and enable the local control API and actions in Settings.",
      );
    },
  };
  for (const version of [1, 2] as const) {
    await assert.rejects(
      new Adapter(gateway, version).initialize(),
      (error: unknown) =>
        error instanceof v1.RequestError &&
        error.code === -32603 &&
        error.message.includes("enable the local control API and actions") &&
        JSON.stringify(error.toResult()).includes("control_unavailable"),
    );
  }
  assert.equal(calls, 2);
});

test("generated CoS images reach ACP v1 and v2 as inline image blocks without control URLs", async () => {
  for (const version of [1, 2] as const) {
    const gateway = new FakeGateway();
    gateway.imageEnabled = true;
    const { app1, app2 } = apps(gateway);
    const notifications: Array<Record<string, unknown>> = [];
    const client = version === 1 ? v1.client() : v2.client();
    client.onNotification("session/update", ({ params }) => {
      notifications.push(params.update as Record<string, unknown>);
    });
    const run = async (ctx: any) => {
      if (version === 1) {
        await ctx.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "t3-fixture", version: "1" },
        });
      } else {
        await ctx.request("initialize", {
          protocolVersion: 2,
          info: { name: "t3-fixture", version: "1" },
          capabilities: {},
        });
      }
      const session = await ctx.request("session/new", {
        cwd: process.cwd(),
        ...(version === 1 ? { mcpServers: [] } : {}),
      });
      await ctx.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "Create image" }],
      });
      if (version === 2) {
        for (let i = 0; i < 25; i++) {
          if (
            notifications.some((update) => {
              const contents = Array.isArray(update.content)
                ? update.content
                : [update.content];
              return contents.some(
                (item) =>
                  !!item &&
                  typeof item === "object" &&
                  (item as { type?: string }).type === "image",
              );
            })
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    };
    if (version === 1) await client.connectWith(app1, run);
    else await client.connectWith(app2, run);
    const images = notifications.flatMap((value) => {
      const contents = Array.isArray(value.content)
        ? value.content
        : [value.content];
      return contents.filter(
        (block) =>
          !!block &&
          typeof block === "object" &&
          (block as { type?: string }).type === "image",
      );
    }) as Array<{ type: string; data: string; mimeType: string; uri?: string }>;
    assert.equal(images.length, 1, `ACP v${version} exposes one image`);
    assert.equal(images[0].mimeType, "image/png");
    assert(images[0].data.startsWith("iVBOR"));
    assert.equal(
      images[0].uri,
      undefined,
      "never sends loopback control URL to T3",
    );
  }
});
