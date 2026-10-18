import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
// Release tooling deliberately runs with Node alone, independently of installed dependencies.
// @ts-expect-error executable release tooling is plain JavaScript
import {
  createManifest,
  verifyRelease,
  checkStateForSwitch,
} from "../scripts/release-tools.mjs";

async function cleanup(root: string) {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith("cos-release-"));
  await rm(resolved, { recursive: true, force: true });
}

test("release verification detects tampering, extra files, and changed Node bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cos-release-"));
  try {
    const release = path.join(root, "release");
    await mkdir(release);
    await writeFile(
      path.join(release, "package.json"),
      JSON.stringify({
        name: "test",
        version: "1.0.0",
        dependencies: { "@agentclientprotocol/sdk": "1.9.0" },
      }),
    );
    await writeFile(path.join(release, "cli.js"), "original");
    const node = path.join(root, "node.exe");
    await writeFile(node, "runtime");
    await createManifest(release, "abcdef012345", node);
    await verifyRelease(release, node);
    await assert.rejects(
      createManifest(release, "abcdef012345", node),
      /EEXIST/,
    );
    await writeFile(path.join(release, "cli.js"), "changed");
    await assert.rejects(verifyRelease(release, node), /checksum/);
    await writeFile(path.join(release, "cli.js"), "original");
    await writeFile(path.join(release, "unexpected.txt"), "extra");
    await assert.rejects(verifyRelease(release, node), /inventory/);
    await rm(path.join(release, "unexpected.txt"));
    await writeFile(node, "new-runtime");
    await assert.rejects(verifyRelease(release, node), /runtime changed/);
  } finally {
    await cleanup(root);
  }
});

test("rollback preflight refuses newer schemas and uncertain live input", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cos-release-db-"));
  const file = path.join(root, "state.sqlite");
  try {
    const db = new DatabaseSync(file);
    db.exec(
      "CREATE TABLE operations(body TEXT NOT NULL); PRAGMA user_version=1",
    );
    db.close();
    const manifest = { stateSchema: { min: 0, max: 1 } };
    assert.deepEqual(checkStateForSwitch(file, manifest), { schema: 1 });
    const pending = new DatabaseSync(file);
    pending
      .prepare("INSERT INTO operations VALUES(?)")
      .run(JSON.stringify({ phase: "uncertain" }));
    pending.close();
    assert.throws(() => checkStateForSwitch(file, manifest), /reconciled/);
    const newer = new DatabaseSync(file);
    newer.exec("PRAGMA user_version=2");
    newer.close();
    assert.throws(() => checkStateForSwitch(file, manifest), /schema/);
    assert.throws(
      () => checkStateForSwitch(file, { stateSchema: { max: 1 } }),
      /schema/,
    );
  } finally {
    await cleanup(root);
  }
});
