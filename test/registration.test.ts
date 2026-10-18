import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const script = resolve("scripts/register-t3.mjs");
test("portable T3 registrar preserves other settings and ignores unsupported native extension by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cos-t3-registration-"));
  const settingsPath = join(dir, "settings.json");
  const registrationPath = join(dir, "provider-registration.json");
  try {
    const old = {
      continueThreadsAfterServerUpdate: false,
      workspace: { unknownFutureSetting: ["preserved"] },
      providerInstances: {
        opencode: { driver: "opencode", enabled: true },
        codex: { driver: "codex", enabled: false },
      },
    };
    await writeFile(settingsPath, JSON.stringify(old));
    const registration = {
      providerInstances: {
        chat_on_steroids: {
          driver: "acpRegistry",
          enabled: true,
          config: {
            source: "local",
            commandPath: "C:/Node/node.exe",
            commandArgs: [
              "--disable-warning=ExperimentalWarning",
              "C:/Bridge/cli.js",
            ],
            integration: "chat-on-steroids",
          },
        },
      },
    };
    await writeFile(registrationPath, "\uFEFF" + JSON.stringify(registration));
    await exec(process.execPath, [
      script,
      "--settings=" + settingsPath,
      "--registration=" + registrationPath,
    ]);
    const changed = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(
      changed.providerInstances.opencode,
      old.providerInstances.opencode,
    );
    assert.deepEqual(
      changed.providerInstances.codex,
      old.providerInstances.codex,
    );
    assert.deepEqual(changed.workspace, old.workspace);
    assert.equal(changed.continueThreadsAfterServerUpdate, false);
    assert.equal(
      changed.providerInstances.chat_on_steroids.config.integration,
      undefined,
    );
    await exec(process.execPath, [
      script,
      "--settings=" + settingsPath,
      "--registration=" + registrationPath,
      "--native",
    ]);
    const nativeSettings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(
      nativeSettings.providerInstances.chat_on_steroids.config.integration,
      "chat-on-steroids",
    );
    // Same-release registration is idempotent and may be re-run.
    await exec(process.execPath, [
      script,
      "--settings=" + settingsPath,
      "--registration=" + registrationPath,
    ]);
    const replaced = {
      ...registration,
      providerInstances: {
        chat_on_steroids: {
          ...registration.providerInstances.chat_on_steroids,
          config: {
            ...registration.providerInstances.chat_on_steroids.config,
            commandArgs: ["x", "different/cli.js"],
          },
        },
      },
    };
    await writeFile(registrationPath, JSON.stringify(replaced));
    await assert.rejects(
      exec(process.execPath, [
        script,
        "--settings=" + settingsPath,
        "--registration=" + registrationPath,
      ]),
      /Disable Chat on Steroids/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test(
  "portable Windows installer declares its documented T3 registration switch",
  { skip: process.platform !== "win32" },
  async () => {
    const installer = resolve("scripts/install.ps1").replaceAll("'", "''");
    const command =
      "(Get-Command '" +
      installer +
      "').Parameters['RegisterT3'].ParameterType.Name";
    const { stdout } = await exec("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
    ]);
    assert.equal(stdout.trim(), "SwitchParameter");
  },
);
