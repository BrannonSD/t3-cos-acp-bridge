import type * as V1 from "@agentclientprotocol/sdk";
import type * as V2 from "@agentclientprotocol/sdk/experimental/v2";
import type { Event, Models, Session, Text } from "./contracts.js";
import { nativeMarkdown } from "./native-markdown.js";
export const visible = (text?: Text) =>
  text
    ? text.text +
      (text.truncated ? "\n[Content truncated by Chat on Steroids]" : "")
    : "";
export const commands = [
  {
    name: "cos-status",
    description: "Show connection, session and worker status",
  },
  { name: "cos-workers", description: "Show worker status and reports" },
  {
    name: "cos-spawn",
    description: "Delegate a task to a CoS worker",
    input: { hint: "Task for the worker" },
  },
  {
    name: "cos-message",
    description: "Send an addressed worker message",
    input: { hint: "worker-1 Your message" },
  },
  {
    name: "cos-goal",
    description: "Run a CoS objective",
    input: { hint: "Objective" },
  },
  { name: "cos-loop", description: "Enable CoS continuation loop" },
  { name: "cos-off", description: "Stop CoS automatic continuation" },
  { name: "compact", description: "Compact the current CoS conversation" },
];
export function options(s: Session, models: Models): V1.SessionConfigOption[] {
  const model = models.models.find((m) => m.id === s.model);
  return [
    {
      id: "model",
      name: "ChatGPT model",
      category: "model",
      type: "select" as const,
      currentValue: model?.id ?? "_cos_current",
      options: [
        { value: "_cos_current", name: "ChatGPT current model" },
        ...models.models.map((m) => ({ value: m.id, name: m.label })),
      ],
    },
    ...(model
      ? [
          {
            id: "reasoning",
            name: "Thinking effort",
            category: "thought_level",
            type: "select" as const,
            currentValue: s.effort ?? model.efforts[0],
            options: model.efforts.map((e) => ({ value: e, name: e })),
          },
        ]
      : []),
    {
      id: "mode",
      name: "Tool permissions",
      category: "mode",
      type: "select",
      currentValue: s.mode,
      options: [
        ...(s.compatibility === "existing-install"
          ? []
          : [
              {
                value: "supervised",
                name: "Supervised",
                description: "Approve each CoS tool operation from T3",
              },
            ]),
        {
          value: "cos",
          name:
            s.compatibility === "existing-install"
              ? "CoS permissions (T3 supervision unavailable)"
              : "CoS permissions",
          description: "Use the existing CoS tool permissions",
        },
      ],
    },
  ];
}
export function sessionCommands(s: Session) {
  return s.compatibility === "existing-install"
    ? commands.filter((c) => ["cos-status", "cos-workers"].includes(c.name))
    : commands;
}
export function v2Options(
  s: Session,
  models: Models,
): V2.SessionConfigOption[] {
  return options(s, models).map(
    ({ id, ...option }) =>
      ({ ...option, configId: id }) as V2.SessionConfigOption,
  );
}
const kind = (value: string): V1.ToolKind =>
  [
    "read",
    "edit",
    "delete",
    "move",
    "search",
    "execute",
    "think",
    "fetch",
    "switch_mode",
  ].includes(value)
    ? (value as V1.ToolKind)
    : "other";
export class Translator {
  readonly text = new Map<string, string>();
  readonly tools = new Set<string>();
  private noteSequence = 0;
  constructor(readonly version: 1 | 2) {}
  event(e: Event): Array<Record<string, unknown>> {
    if (e.unreadable) return this.note("A recorded event could not be read.");
    if (e.kind === "assistant_message" || e.kind === "user_message") {
      const messageId =
        e.messageId ?? `${e.kind}:${e.turnId ?? "history"}:${e.position}`;
      const text =
        e.kind === "assistant_message"
          ? nativeMarkdown(visible(e.message))
          : visible(e.message);
      const before = this.text.get(messageId) ?? "";
      this.text.set(messageId, text);
      if (this.version === 2)
        return [
          {
            sessionUpdate:
              e.kind === "assistant_message" ? "agent_message" : "user_message",
            messageId,
            content: [{ type: "text", text }],
          },
        ];
      if (text === before) return [];
      const suffix = text.startsWith(before)
        ? text.slice(before.length)
        : `\n[Response revised]\n${text}`;
      return [
        {
          sessionUpdate:
            e.kind === "assistant_message"
              ? "agent_message_chunk"
              : "user_message_chunk",
          content: { type: "text", text: suffix },
          _meta: { "chat-on-steroids/messageId": messageId },
        },
      ];
    }
    if (e.kind === "tool_call" && e.tool) {
      const t = e.tool;
      const first = !this.tools.has(t.callId);
      this.tools.add(t.callId);
      const status: V1.ToolCallStatus = /^(ok|success|completed|done)$/.test(
        t.outcome,
      )
        ? "completed"
        : /^(running|pending|started)$/.test(t.outcome)
          ? "in_progress"
          : "failed";
      const update = {
        sessionUpdate:
          this.version === 2 || !first
            ? ("tool_call_update" as const)
            : ("tool_call" as const),
        toolCallId: t.callId,
        title: t.summary.title,
        kind: kind(t.summary.kind),
        status,
        rawInput: visible(t.args),
        rawOutput: visible(t.result),
        locations: t.changes.map((c) => ({ path: c.path })),
        content: [
          {
            type: "content" as const,
            content: { type: "text" as const, text: visible(t.result) },
          },
        ],
        _meta: { "chat-on-steroids/name": t.name },
      };
      return [update];
    }
    if (
      [
        "progress",
        "chat_error",
        "handoff",
        "agent_message",
        "note",
        "page_tool",
        "native_image",
      ].includes(e.kind)
    ) {
      const detail = e.message ? visible(e.message) : (e.detail ?? e.kind);
      if (e.kind === "native_image")
        return this.note(
          "Chat on Steroids generated an image. Open the conversation in CoS to view the original.",
        );
      return this.note(detail);
    }
    return [];
  }
  note(text: string): Array<Record<string, unknown>> {
    const messageId = `cos-status:${++this.noteSequence}`;
    return [
      {
        sessionUpdate: "agent_thought_chunk",
        ...(this.version === 2 ? { messageId } : {}),
        content: { type: "text", text: text + "\n" },
      },
    ];
  }
}
