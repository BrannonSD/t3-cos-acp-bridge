import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

test("portable ACP smoke isolates auto-start and accepts an alternate installation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cos-stdio-smoke-test-"));
  try {
    const cli = join(dir, "stub-cli.mjs");
    const installation = join(dir, "installation.json");
    await writeFile(
      cli,
      [
        'import { createInterface } from "node:readline";',
        "const input = createInterface({ input: process.stdin });",
        'input.on("line", (line) => {',
        "  const request = JSON.parse(line);",
        '  const isolated = process.env.COS_ACP_AUTOSTART === "0" &&',
        '    process.env.COS_USER_DATA?.endsWith("disabled-cos");',
        '  const message = isolated ? "Enable the local control API and actions." : "Unsafe inherited startup";',
        '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id,',
        '    error: { code: -32603, message } }) + "\\n");',
        "});",
      ].join("\n"),
    );
    await writeFile(
      installation,
      JSON.stringify({
        node: process.execPath,
        release: dir,
        mode: "existing-install",
      }),
    );
    const { stdout } = await exec(
      process.execPath,
      [resolve("scripts/smoke-stdio.mjs"), cli, installation],
      {
        env: { ...process.env, COS_ACP_AUTOSTART: "1" },
        timeout: 20_000,
      },
    );
    assert.match(stdout, /ACP v1: valid JSON-RPC/);
    assert.match(stdout, /ACP v2: valid JSON-RPC/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
