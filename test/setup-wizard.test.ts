import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const setup = resolve("scripts/setup-wizard.ps1");
async function powershell(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  return exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      setup,
      ...args,
    ],
    { env, windowsHide: true, timeout: 45_000 },
  );
}

test(
  "Windows wizard validates native WPF controls without opening windows or changing settings",
  { skip: process.platform !== "win32" },
  async () => {
    const { stdout } = await powershell(["-ValidateUi"]);
    assert.match(stdout, /SETUP_UI_VALID/);
  },
);

test(
  "wizard preflight is machine-agnostic and blocks enabled-provider upgrades",
  { skip: process.platform !== "win32" },
  async () => {
    const base = await mkdtemp(join(tmpdir(), "cos-wizard-"));
    const home = join(base, "profile");
    const local = join(base, "local");
    const exe = join(base, "program", "Chat On Steroids.exe");
    const settings = join(home, ".t3", "userdata", "settings.json");
    const installed = join(local, "T3-CoS-Integration");
    const env = {
      ...process.env,
      USERPROFILE: home,
      LOCALAPPDATA: local,
      COS_ACP_COS_EXE: exe,
      COS_ACP_AUTOSTART: "0",
    };
    try {
      await mkdir(join(home, ".t3", "userdata"), { recursive: true });
      await mkdir(join(base, "program"), { recursive: true });
      await mkdir(installed, { recursive: true });
      await writeFile(exe, "");
      await writeFile(join(installed, "installation.json"), "{}");
      async function ready(enabled: boolean) {
        await writeFile(
          settings,
          JSON.stringify({
            providerInstances: { chat_on_steroids: { enabled } },
          }),
        );
        const { stdout } = await powershell(
          ["-CheckOnly", "-InstallRoot", installed],
          env,
        );
        return JSON.parse(stdout) as {
          nodeReady: boolean;
          npmReady: boolean;
          t3Ready: boolean;
          cosReady: boolean;
          providerEnabled: boolean;
          upgradeBlocked: boolean;
          canInstall: boolean;
          existingInstall: boolean;
        };
      }
      const blocked = await ready(true);
      assert.equal(blocked.providerEnabled, true);
      assert.equal(blocked.existingInstall, true);
      assert.equal(blocked.upgradeBlocked, true);
      assert.equal(blocked.canInstall, false);
      const cleared = await ready(false);
      assert.equal(cleared.upgradeBlocked, false);
      assert.equal(cleared.nodeReady, true);
      assert.equal(cleared.npmReady, true);
      assert.equal(cleared.t3Ready, true);
      assert.equal(cleared.cosReady, true);
      assert.equal(cleared.canInstall, true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  },
);

test(
  "wizard rejects unsafe roots before installer invocation",
  { skip: process.platform !== "win32" },
  async () => {
    const base = await mkdtemp(join(tmpdir(), "cos-wizard-root-"));
    try {
      const accepted = await powershell([
        "-ValidateRoot",
        "-InstallRoot",
        join(base, "separate-adapter"),
      ]);
      assert.match(accepted.stdout, /separate-adapter/);
      await assert.rejects(
        powershell(["-ValidateRoot", "-InstallRoot", "relative"]),
        /absolute local Windows path/,
      );
      await assert.rejects(
        powershell(["-ValidateRoot", "-InstallRoot", "C:\\"]),
        /dedicated integration folder/,
      );
      const other = join(base, "other");
      await mkdir(other);
      await writeFile(join(other, "unrelated.txt"), "not an installation");
      await assert.rejects(
        powershell(["-ValidateRoot", "-InstallRoot", other]),
        /empty folder or an existing/,
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  },
);
