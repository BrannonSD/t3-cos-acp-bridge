import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { MainInstall, shellLaunchScript } from "../src/main-install.js";

function fixture() {
  const env = {
    COS_ACP_AUTOSTART: "1",
    APPDATA: path.resolve("test-profile"),
    LOCALAPPDATA: path.resolve("test-local"),
    ELECTRON_RUN_AS_NODE: "1",
  };
  const directory = path.join(env.APPDATA, "chat-on-steroids", "control-api");
  let alive = false;
  const launches: Array<{ exe: string; env: NodeJS.ProcessEnv }> = [];
  let enabled = true;
  const io = {
    read: async (file: string) =>
      file.endsWith("config.json")
        ? JSON.stringify({ controlApi: { enabled, allowActions: true } })
        : JSON.stringify({ pid: 123 }),
    file: async () => true,
    running: () => alive,
    wait: async () => {
      alive = true;
    },
    now: () => 1000,
    launch: async (exe: string, childEnv: NodeJS.ProcessEnv) => {
      launches.push({ exe, env: childEnv });
    },
  };
  return {
    env,
    directory,
    launches,
    io,
    alive: () => {
      alive = true;
    },
    disable: () => {
      enabled = false;
    },
  };
}
test("Windows shell owns the app outside T3's disposable process tree, with safe literal paths and Node mode cleared", () => {
  const exe =
    "C:\\Users\\O'Brien\\AppData\\Local\\Programs\\Chat On Steroids\\Chat On Steroids.exe";
  const script = shellLaunchScript(exe);
  assert(script.includes("Shell.Application"));
  assert(script.includes("ShellExecute"));
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(script)![1];
  const payload = Buffer.from(encoded, "base64").toString("utf16le");
  assert(payload.includes("$env:ELECTRON_RUN_AS_NODE=$null"));
  assert(payload.includes("O''Brien"));
  assert(payload.includes("-WindowStyle Hidden"));
  assert(!payload.includes("--user-data-dir"));
});

test("broker shell startup carries only explicit environment and quoted Node arguments", () => {
  const script = shellLaunchScript(
    "C:\\Node runtime\\node.exe",
    [
      "--disable-warning=ExperimentalWarning",
      "C:\\O'Brien\\bridge files\\cli.js",
      "--broker",
    ],
    { COS_ACP_HOME: "C:\\adapter's state", COS_ACP_MODE: "existing-install" },
  );
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(script)![1];
  const payload = Buffer.from(encoded, "base64").toString("utf16le");
  assert(payload.includes("$env:COS_ACP_HOME='C:\\adapter''s state'"));
  assert(payload.includes("\"C:\\O''Brien\\bridge files\\cli.js\""));
  assert(payload.includes('"--broker"'));
  assert(payload.includes("$env:ELECTRON_RUN_AS_NODE=$null"));
  assert.throws(() => shellLaunchScript("node", [], { "BAD;KEY": "no" }));
});
test("opted-in cold startup launches only the main installed CoS once and clears Electron Node mode", async () => {
  const f = fixture();
  const main = new MainInstall(
    f.directory,
    "existing-install",
    f.env,
    f.io,
    "win32",
  );
  await Promise.all([main.ensure(), main.ensure(), main.ensure()]);
  assert.equal(f.launches.length, 1);
  assert.equal(
    f.launches[0].exe,
    path.join(
      f.env.LOCALAPPDATA,
      "Programs",
      "Chat On Steroids",
      "Chat On Steroids.exe",
    ),
  );
  assert.equal(f.launches[0].env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(f.env.ELECTRON_RUN_AS_NODE, "1");
  await main.ensure();
  assert.equal(f.launches.length, 1);
});
test("startup refuses alternate profiles, modes, disabled control and missing installs; never changes config", async () => {
  const f = fixture();
  for (const [directory, mode] of [
    [f.directory + "-other", "existing-install"],
    [f.directory, "modern"],
  ]) {
    await assert.rejects(
      new MainInstall(directory, mode, f.env, f.io, "win32").ensure(),
      { code: "autostart_profile_refused" },
    );
  }
  f.disable();
  await assert.rejects(
    new MainInstall(
      f.directory,
      "existing-install",
      f.env,
      f.io,
      "win32",
    ).ensure(),
    { code: "control_unavailable" },
  );
  const missing = fixture();
  missing.io.file = async () => false;
  await assert.rejects(
    new MainInstall(
      missing.directory,
      "existing-install",
      missing.env,
      missing.io,
      "win32",
    ).ensure(),
    { code: "main_install_not_found" },
  );
  assert.equal(f.launches.length, 0);
  assert.equal(missing.launches.length, 0);
});
test("startup is opt-in, reuses running CoS, and a timed-out launch cannot cause a launch storm", async () => {
  const f = fixture();
  await new MainInstall(
    f.directory,
    "existing-install",
    { ...f.env, COS_ACP_AUTOSTART: undefined },
    f.io,
    "win32",
  ).ensure();
  assert.equal(f.launches.length, 0);
  f.alive();
  await new MainInstall(
    f.directory,
    "existing-install",
    f.env,
    f.io,
    "win32",
  ).ensure();
  assert.equal(f.launches.length, 0);
  const slow = fixture();
  slow.io.wait = async () => {};
  const main = new MainInstall(
    slow.directory,
    "existing-install",
    slow.env,
    slow.io,
    "win32",
  );
  await assert.rejects(main.ensure(), { code: "main_install_starting" });
  await assert.rejects(main.ensure(), { code: "main_install_starting" });
  assert.equal(slow.launches.length, 1);
});
