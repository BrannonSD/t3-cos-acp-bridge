import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BridgeError, type Health } from "./contracts.js";

export type IntegrationMode = "modern" | "existing-install";
export interface Compatibility {
  version: 1;
  appVersion: string;
  tier: "modern" | "existing-install";
  permissions: "supervised-and-cos" | "cos-only";
  workspace: "runtime-cwd" | "exact-local-project";
  models: boolean;
  attachments: boolean;
  stagedAttachments: boolean;
  unboundChats: boolean;
  workerObservation: boolean;
  assets: boolean;
  sessionWorkers: boolean;
  automation: boolean;
  compact: boolean;
}
export function integrationMode(
  value = process.env.COS_ACP_MODE,
): IntegrationMode {
  if (value === undefined || value === "modern") return "modern";
  if (value === "existing-install") return value;
  throw new BridgeError(
    "invalid_integration_mode",
    "COS_ACP_MODE must be modern or existing-install.",
  );
}
/**
 * Stock CoS does not advertise an integration manifest, so its releases are
 * matched by the capabilities they actually expose. 2.1.39 is the oldest
 * release verified to expose the durable submit/replay/cancel contract this
 * tier requires; release versions themselves are diagnostics, not
 * compatibility evidence. Later releases in the same major family stay
 * accepted because their surface has only been additive so far (2.1.40 adds
 * the account model catalog and optional model/effort input fields) and every
 * use of those capabilities is negotiated separately from advertised routes.
 * A new major version can change identity or delivery semantics, so it fails
 * closed until the adapter is updated. Unparseable versions always fail.
 */
export function stockVersion(value: string | undefined) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value ?? "");
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}
export function supportedStockVersion(value: string | undefined) {
  const version = stockVersion(value);
  return (
    version !== undefined &&
    version.major === 2 &&
    (version.minor > 1 || (version.minor === 1 && version.patch >= 39))
  );
}
export function negotiate(h: Health, mode: IntegrationMode): Compatibility {
  const manifest = h.integrationManifest;
  if (
    manifest &&
    (manifest.id !== "chat-on-steroids.control" ||
      manifest.version !== 1 ||
      !manifest.features ||
      typeof manifest.features !== "object")
  )
    throw new BridgeError(
      "incompatible_runtime",
      "CoS advertises an unsupported integration manifest. Keep the current release and upgrade the adapter before submitting work.",
    );
  const feature = (key: string) => !manifest || manifest.features[key] === 1;
  const reads = [
    "/v1/sessions",
    "/v1/sessions/{id}",
    "/v1/sessions/{id}/events",
    "/v1/sessions/{id}/events/stream",
    "/v1/inputs",
  ];
  const writes = [
    "POST /v1/inputs",
    "POST /v1/inputs/{id}/cancel",
    "POST /v1/sessions/{id}/stop",
  ];
  if (
    h.protocol !== 1 ||
    reads.some((r) => !h.routes.includes(r)) ||
    writes.some((r) => !h.actions.routes.includes(r))
  )
    throw new BridgeError(
      "incompatible_runtime",
      "CoS is missing required durable input, replay, or cancellation routes. No prompt was submitted.",
    );
  const modern =
    h.routes.includes("/v1/projects") &&
    h.actions.routes.includes("POST /v1/sessions/{id}/approval-policy") &&
    feature("listenerIdentity") &&
    feature("sessionCwd") &&
    feature("integrationApprovals") &&
    feature("projects") &&
    feature("inputLookup");
  if (!modern && manifest)
    throw new BridgeError(
      "incompatible_runtime",
      "CoS's integration manifest lacks a supported workspace, identity, approval, or durable lookup contract. This runtime cannot fall back to stock compatibility.",
    );
  if (
    !modern &&
    (mode !== "existing-install" || !supportedStockVersion(h.appVersion))
  )
    throw new BridgeError(
      "runtime_update_required",
      `Chat on Steroids ${h.appVersion ?? "with an unknown version"} does not advertise the integration manifest. Explicit existing-install mode supports the verified stock contract on CoS 2.1.39 and later 2.x releases; a newer major version needs an updated adapter.`,
    );
  if (mode === "modern" && !h.routes.includes("/v1/models"))
    throw new BridgeError(
      "incompatible_runtime",
      "The integration runtime must expose its account-observed model catalog.",
    );
  if (modern && !h.routes.includes("/v1/inputs/{id}"))
    throw new BridgeError(
      "incompatible_runtime",
      "The integration runtime must expose durable input lookup for reconciliation.",
    );
  return {
    version: 1,
    appVersion: h.appVersion ?? "unknown",
    tier: modern ? "modern" : "existing-install",
    permissions: modern ? "supervised-and-cos" : "cos-only",
    workspace: modern ? "runtime-cwd" : "exact-local-project",
    models: h.routes.includes("/v1/models") && feature("inputModels"),
    attachments:
      h.actions.routes.includes("POST /v1/attachments") &&
      feature("attachmentIngress"),
    stagedAttachments: !modern,
    unboundChats: !modern,
    workerObservation:
      h.routes.includes("/v1/workers/{ownerId}") ||
      h.routes.includes("/v1/sessions/{id}/workers"),
    assets:
      h.routes.includes("/v1/sessions/{id}/assets/{assetId}") &&
      feature("sessionAssets"),
    sessionWorkers:
      h.routes.includes("/v1/sessions/{id}/workers") &&
      feature("sessionWorkers"),
    automation:
      h.actions.routes.includes("POST /v1/sessions/{id}/automation") &&
      feature("sessionAutomation"),
    compact:
      h.actions.routes.includes("POST /v1/sessions/{id}/compact") &&
      feature("sessionCompaction"),
  };
}
const run = promisify(execFile);
/** OS identity is required only for the known stock listener/process timestamp split. */
export async function windowsProcessStartedAt(pid: number): Promise<number> {
  if (process.platform !== "win32" || !Number.isSafeInteger(pid) || pid < 1)
    throw new BridgeError(
      "process_identity_unavailable",
      "The existing CoS process identity cannot be verified on this host.",
    );
  const { stdout } = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
    ],
    { windowsHide: true, timeout: 5000 },
  );
  const at = Date.parse(stdout.trim());
  if (!Number.isFinite(at)) throw new Error("invalid process start");
  return at;
}
export function validateLegacyIdentity(
  h: Health,
  endpoint: { appVersion?: string; startedAt: string },
  osStart: number,
  now = Date.now(),
) {
  const processStart = Date.parse(h.startedAt);
  const listenerStart = Date.parse(endpoint.startedAt);
  // Node initializes shortly after Windows creates Electron's main process.
  // This structural exception for the stock split timestamps (health reports
  // the process start; discovery records when this listener started) is
  // granted per connection, never per version string alone: both sides must
  // report the same supported stock release, and the OS must prove the health
  // timestamp is this exact process's creation time.
  if (
    !supportedStockVersion(h.appVersion) ||
    endpoint.appVersion === undefined ||
    endpoint.appVersion !== h.appVersion ||
    !Number.isFinite(osStart) ||
    !Number.isFinite(processStart) ||
    !Number.isFinite(listenerStart) ||
    processStart < osStart - 1000 ||
    processStart > osStart + 10_000 ||
    listenerStart < processStart - 1000 ||
    listenerStart > now + 1000
  )
    throw new BridgeError(
      "wrong_application",
      "The local endpoint does not match the running CoS process identity.",
    );
}
const identity = (p: string) =>
  process.platform === "win32" ? p.toLowerCase() : p;
export async function canonical(p: string) {
  return identity(await realpath(p));
}
/** Only a readable, valid profile can produce this probe-eligible refusal. */
export class ProjectBindingRefusal extends BridgeError {
  constructor() {
    super(
      "project_binding_unavailable",
      "Existing-install mode requires this exact local folder to be a current CoS project inside its approved roots. Unknown worktrees are refused; add the folder through CoS first.",
    );
  }
}
/** Read-only projection of the stock CoS catalog; never edits config, grants, or history. */
export async function existingProject(
  profile: string,
  cwd: string,
  expectedId?: string,
): Promise<{ id: string; root: string }> {
  try {
    const [rawCatalog, rawConfig] = await Promise.all([
      readFile(path.join(profile, "state", "projects.json"), "utf8"),
      readFile(path.join(profile, "config.json"), "utf8"),
    ]);
    const catalog = JSON.parse(rawCatalog) as Array<{
      id: string;
      path: string;
      remote?: unknown;
      ungrouped?: boolean;
    }>;
    const config = JSON.parse(rawConfig) as {
      roots: Array<{ path: string; remote?: unknown }>;
    };
    if (
      !Array.isArray(catalog) ||
      catalog.length > 200 ||
      !Array.isArray(config.roots) ||
      catalog.some(
        (project) =>
          !project ||
          typeof project.id !== "string" ||
          typeof project.path !== "string",
      ) ||
      config.roots.some((grant) => !grant || typeof grant.path !== "string") ||
      new Set(catalog.map((project) => project.id)).size !== catalog.length
    )
      throw new Error("schema");
    const requested = await canonical(cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error("directory");
    for (const project of catalog) {
      if (
        project.remote ||
        project.ungrouped ||
        (expectedId && project.id !== expectedId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          project.id,
        ) ||
        !path.isAbsolute(project.path)
      )
        continue;
      const root = await canonical(project.path).catch(() => null);
      if (root !== requested || root !== identity(path.resolve(project.path)))
        continue;
      for (const grant of config.roots) {
        if (
          grant.remote ||
          typeof grant.path !== "string" ||
          !path.isAbsolute(grant.path)
        )
          continue;
        const allowed = await canonical(grant.path).catch(() => null);
        if (!allowed || allowed !== identity(path.resolve(grant.path)))
          continue;
        const relative = path.relative(allowed, requested);
        if (
          relative === "" ||
          (!relative.startsWith(".." + path.sep) &&
            relative !== ".." &&
            !path.isAbsolute(relative))
        )
          return { id: project.id, root: requested };
      }
    }
  } catch {
    /* Corrupt, missing, or changed profile state never authorizes an unfiled chat. */
    throw new BridgeError(
      "project_binding_unavailable",
      "The CoS project profile could not be verified. Check its configuration and catalog before creating a session.",
    );
  }
  throw new ProjectBindingRefusal();
}
export async function existingProjectById(profile: string, id: string) {
  try {
    const catalog = JSON.parse(
      await readFile(path.join(profile, "state", "projects.json"), "utf8"),
    ) as Array<{ id: string; path: string }>;
    const project = catalog.find((p) => p.id === id);
    if (!project) return undefined;
    return await existingProject(profile, project.path, id);
  } catch {
    return undefined;
  }
}
