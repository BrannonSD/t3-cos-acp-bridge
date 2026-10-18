import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
  readdir,
  lstat,
  unlink,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { BridgeError } from "./contracts.js";

const MAX_BYTES = 16 * 1024 * 1024;
const extension: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "application/json": ".json",
};
const normalized = (p: string) =>
  process.platform === "win32" ? p.toLowerCase() : p;
const within = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative))
  );
};

/** Read only CoS's own filesystem grants, never edit its profile or project registry. */
export async function approvedRoots(profile: string): Promise<string[]> {
  try {
    const config = JSON.parse(
      await readFile(path.join(profile, "config.json"), "utf8"),
    );
    if (!Array.isArray(config.roots) || config.roots.length > 100)
      throw new Error("roots");
    const roots: string[] = [];
    for (const grant of config.roots) {
      if (
        !grant ||
        typeof grant.path !== "string" ||
        grant.remote ||
        !path.isAbsolute(grant.path)
      )
        continue;
      const actual = await realpath(grant.path).catch(() => null);
      if (!actual) continue;
      const root = normalized(actual);
      if (
        root !== normalized(path.resolve(grant.path)) ||
        !(await stat(grant.path).catch(() => null))?.isDirectory()
      )
        continue;
      roots.push(root);
    }
    return roots;
  } catch {
    throw new BridgeError(
      "project_binding_unavailable",
      "CoS filesystem permissions could not be verified.",
    );
  }
}

export async function approvedDirectory(profile: string, cwd: string) {
  if (!path.isAbsolute(cwd)) return false;
  const actual = await realpath(cwd).catch(() => null);
  if (!actual || !(await stat(actual)).isDirectory()) return false;
  return (await approvedRoots(profile)).some((root) =>
    within(root, normalized(actual)),
  );
}

/** Stage only caller-provided bytes under a validated CoS root for CoS's own image/file tools. */
export async function stageStockFile(
  profile: string,
  cwd: string,
  file: {
    data: string;
    name?: string;
    mimeType?: string;
  },
): Promise<{ path: string; name: string; mimeType: string; size: number }> {
  const mimeType = file.mimeType || "application/octet-stream";
  if (
    typeof file.data !== "string" ||
    !file.data.length ||
    file.data.length > Math.ceil((MAX_BYTES * 4) / 3) + 8 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      file.data,
    )
  )
    throw new BridgeError(
      "invalid_attachment",
      "The attachment is missing, invalid, or exceeds 16 MiB.",
    );
  const bytes = Buffer.from(file.data, "base64");
  if (
    !bytes.length ||
    bytes.length > MAX_BYTES ||
    bytes.toString("base64") !== file.data
  )
    throw new BridgeError(
      "invalid_attachment",
      "The attachment bytes could not be verified.",
    );
  const roots = await approvedRoots(profile);
  if (!roots.length)
    throw new BridgeError(
      "no_approved_root",
      "Add at least one local CoS folder to stage attachments.",
    );
  const actual = await realpath(cwd).catch(() => null);
  const target = actual && normalized(actual);
  const root = roots.find((r) => target && within(r, target)) ?? roots[0]!;
  const directory = path.join(root, ".cos-acp-attachments");
  await mkdir(directory, { recursive: true });
  if (
    normalized(await realpath(directory)) !==
    normalized(path.resolve(directory))
  )
    throw new BridgeError(
      "invalid_staging_root",
      "The attachment staging directory is redirected.",
    );
  // Keep files available for resumed sessions, but remove only our own stale
  // UUID-named files from this dedicated directory after 30 days.
  const staleBefore = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const entries = await readdir(directory).catch(() => []);
  for (const name of entries.slice(0, 300)) {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,28}\.[a-z0-9]{1,10}$/.test(name)) continue;
    const old = path.join(directory, name);
    const metadata = await lstat(old).catch(() => null);
    if (
      metadata?.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.mtimeMs < staleBefore
    )
      await unlink(old).catch(() => undefined);
  }
  const originalName = path.basename(
    (file.name || "attachment").replace(/\\/g, "/"),
  );
  const suffix =
    extension[mimeType] ??
    (/^\.[a-z0-9]{1,10}$/i.test(path.extname(originalName))
      ? path.extname(originalName).toLowerCase()
      : ".bin");
  const fullPath = path.join(directory, randomUUID() + suffix);
  await writeFile(fullPath, bytes, { flag: "wx", mode: 0o600 });
  return { path: fullPath, name: originalName, mimeType, size: bytes.length };
}
/** Stage only a local file explicitly sent by ACP as an attachment reference. */
export async function stageStockReference(
  profile: string,
  cwd: string,
  uri: string,
) {
  let input: string;
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") throw new Error("not local");
    input = fileURLToPath(url);
  } catch {
    throw new BridgeError(
      "invalid_attachment",
      "Only local file attachment references can be staged.",
    );
  }
  // An ACP resource link is just a URI, so limit source reads to its T3
  // working folder or a directory CoS has already approved.
  const source = await realpath(input).catch(() => null);
  const requestedRoot = await realpath(cwd).catch(() => null);
  const allowed = await approvedRoots(profile);
  if (
    !source ||
    (!(
      requestedRoot && within(normalized(requestedRoot), normalized(source))
    ) &&
      !allowed.some((root) => within(root, normalized(source))))
  )
    throw new BridgeError(
      "invalid_attachment",
      "The referenced file is outside the current T3 folder and CoS approved roots.",
    );
  const metadata = await stat(source).catch(() => null);
  if (!metadata?.isFile() || metadata.size < 1 || metadata.size > MAX_BYTES)
    throw new BridgeError(
      "invalid_attachment",
      "The referenced file is unavailable or exceeds 16 MiB.",
    );
  const data = await readFile(source);
  if (data.length !== metadata.size)
    throw new BridgeError(
      "invalid_attachment",
      "The referenced attachment changed during staging.",
    );
  return stageStockFile(profile, cwd, {
    data: data.toString("base64"),
    name: path.basename(input),
  });
}
