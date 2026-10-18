export interface Text {
  text: string;
  truncated?: boolean;
  chars?: number;
}
export interface Event {
  seq: number;
  position: number;
  kind: string;
  turnId?: string;
  message?: Text;
  messageId?: string;
  inputId?: string;
  inputDelivery?: string;
  final?: boolean;
  outcome?: string;
  detail?: string;
  unreadable?: boolean;
  assets?: Array<{
    id: string;
    mimeType: string;
    bytes: number;
    width?: number;
    height?: number;
  }>;
  from?: string;
  to?: string;
  tool?: {
    callId: string;
    name: string;
    outcome: string;
    summary: { title: string; detail?: string; kind: string };
    args: Text;
    result: Text;
    changes: Array<{ path: string; added: number; removed: number }>;
  };
}
export interface Input {
  id: string;
  sessionId: string | null;
  deliveredSessionId: string | null;
  conversationId: string | null;
  delivery: "sent" | "not_sent" | "unconfirmed" | "pending";
  state: string;
  messageId: string | null;
  error: string | null;
}
export interface Session {
  id: string;
  cosId: string | null;
  cwd: string;
  model: string | null;
  effort: string | null;
  mode: "supervised" | "cos";
  seq: number;
  title: string;
  updatedAt: number;
  activeInput: string | null;
  lastInput?: string | null;
  conversationId: string | null;
  compatibility?: "modern" | "existing-install";
  projectId?: string;
}
export interface Operation {
  id: string;
  sessionId: string;
  fingerprint: string;
  phase:
    | "prepared"
    | "admitted"
    | "uncertain"
    | "complete"
    | "cancelled"
    | "failed";
  turnId: string | null;
  delivery: Input["delivery"];
  error: string | null;
  baseline: number;
  /** CoS generated the next automatic continuation message. */
  continuationQueued?: boolean;
  /** Its interrupted turn has ended; wait for the next turn_start. */
  awaitingContinuation?: boolean;
  /** Exact stream-owned turns admitted by this input, including continuations. */
  continuationTurnIds?: string[];
}
export interface Models {
  state: string;
  models: Array<{ id: string; label: string; efforts: string[] }>;
}
export interface Health {
  ok: true;
  protocol: number;
  pid: number;
  startedAt: string;
  appVersion?: string;
  integrationManifest?: {
    id: string;
    version: number;
    features: Record<string, number>;
  };
  integration?: import("./compatibility.js").Compatibility;
  actions: { enabled: boolean; routes: string[] };
  routes: string[];
}
export interface Attachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  preview?: string;
}
export interface Approval {
  id: string;
  sessionId: string;
  tool: string;
  title: string;
  description: string;
}
export interface BrokerCall {
  method: string;
  params?: Record<string, unknown>;
}
export interface BrokerResponse {
  result?: unknown;
  error?: { code: string; message: string };
}
export class BridgeError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
