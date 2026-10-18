/**
 * Read-only ACP wire smoke against an installed (or explicitly supplied) CLI.
 * Uses a private temporary broker state and an intentionally missing CoS profile.
 * Sends initialize only, never session/new, session/prompt or CoS actions.
 *
 * Usage: node scripts/smoke-stdio.mjs [absolute-path-to-dist/cli.js] [absolute-path-to-installation.json]
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const installRoot = path.join(
  process.env.LOCALAPPDATA ?? os.tmpdir(),
  "T3-CoS-Integration",
);
const installationPath =
  process.argv[3] ?? path.join(installRoot, "installation.json");
const manifest = JSON.parse(
  (await readFile(installationPath, "utf8")).replace(/^\uFEFF/, ""),
);
const cli = process.argv[2] ?? path.join(manifest.release, "dist", "cli.js");
const state = await mkdtemp(path.join(os.tmpdir(), "cos-acp-stdio-smoke-"));
const env = {
  ...process.env,
  COS_ACP_AUTOSTART: "0",
  COS_ACP_MODE: manifest.mode ?? "existing-install",
  COS_ACP_HOME: state,
  COS_USER_DATA: path.join(state, "disabled-cos"),
};

async function initialize(version) {
  const child = spawn(
    manifest.node,
    ["--disable-warning=ExperimentalWarning", cli],
    { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  let stdout = "";
  const frames = [];
  const closed = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  const reply = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("ACP stdio initialization timed out")),
      22_000,
    );
    child.once("error", reject);
    child.stdout.on("data", (bytes) => {
      stdout += bytes.toString();
      while (stdout.includes("\n")) {
        const next = stdout.indexOf("\n");
        const line = stdout.slice(0, next).trim();
        stdout = stdout.slice(next + 1);
        if (!line) continue;
        try {
          const frame = JSON.parse(line);
          frames.push(frame);
          if (frame.id === version) {
            clearTimeout(timeout);
            resolve(frame);
          }
        } catch (error) {
          clearTimeout(timeout);
          reject(
            new Error("Adapter printed non-JSON-RPC content on stdout", {
              cause: error,
            }),
          );
          return;
        }
      }
    });
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes.toString();
    if (stderr.length > 4096) stderr = stderr.slice(0, 4096);
  });
  const params =
    version === 1
      ? {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "isolated-smoke", version: "1" },
        }
      : {
          protocolVersion: 2,
          info: { name: "isolated-smoke", version: "1" },
          capabilities: {},
        };
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: version,
        method: "initialize",
        params,
      }) + "\n",
    );
    const response = await reply;
    assert.equal(frames.length, 1, "stdout contains only one ACP response");
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(
      response.error?.code,
      -32603,
      "disabled CoS must refuse initialization",
    );
    assert.match(
      response.error?.message ?? "",
      /enable the local control API and actions/i,
    );
    assert.equal(stderr.length, 0, "ACP process must not print debug data");
    console.log(
      `ACP v${version}: valid JSON-RPC, actionable disabled-control error, no stderr`,
    );
  } finally {
    child.stdin.end();
    child.kill();
    await closed;
  }
}

try {
  await initialize(1);
  await initialize(2);
} finally {
  // Only the broker created inside this uniquely allocated test directory can
  // be terminated. Verify the known pipe before signalling its recorded PID.
  try {
    const found = JSON.parse(
      await readFile(path.join(state, "broker.json"), "utf8"),
    );
    const expected =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cos-acp-${createHash("sha256").update(state).digest("hex").slice(0, 24)}`
        : path.join(state, "broker.sock");
    if (
      found.pipe === expected &&
      Number.isSafeInteger(found.pid) &&
      found.pid > 0
    )
      process.kill(found.pid, "SIGTERM");
  } catch {
    /* Already stopped, or discovery never completed. */
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  await rm(state, {
    recursive: true,
    force: true,
    retries: 3,
    retryDelay: 150,
  });
}
