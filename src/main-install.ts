import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { BridgeError } from "./contracts.js";
import { launchOutsideTree } from "./windows-launch.js";
export { shellLaunchScript } from "./windows-launch.js";

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaults = {
  read: (file: string) => readFile(file, "utf8"),
  file: async (file: string) => (await stat(file)).isFile(),
  running,
  wait: pause,
  now: Date.now,
  launch: async (exe: string, _env: NodeJS.ProcessEnv) =>
    launchOutsideTree(exe),
};

/** Opt-in lifecycle for the user's installed app; never selects another profile. */
export class MainInstall {
  private starting?: Promise<void>;
  private lastLaunch = -Infinity;
  constructor(
    readonly directory: string,
    readonly mode: string,
    readonly env: NodeJS.ProcessEnv = process.env,
    readonly io = defaults,
    readonly platform = process.platform,
  ) {}
  private async alive() {
    try {
      const endpoint = JSON.parse(
        await this.io.read(path.join(this.directory, "endpoint.json")),
      );
      return (
        Number.isSafeInteger(endpoint.pid) &&
        endpoint.pid > 0 &&
        this.io.running(endpoint.pid)
      );
    } catch {
      return false;
    }
  }
  async ensure() {
    if (this.env.COS_ACP_AUTOSTART !== "1") return;
    const profile =
      this.env.APPDATA && path.join(this.env.APPDATA, "chat-on-steroids");
    if (
      this.platform !== "win32" ||
      this.mode !== "existing-install" ||
      !profile ||
      path.resolve(this.directory).toLowerCase() !==
        path.resolve(profile, "control-api").toLowerCase()
    )
      throw new BridgeError(
        "autostart_profile_refused",
        "Automatic startup is supported only for the main installed CoS Windows profile in existing-install mode.",
      );
    if (await this.alive()) return;
    this.starting ??= this.start(profile).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private async start(profile: string) {
    // Missing endpoint can also mean the user disabled local control. Never enable it.
    let config;
    try {
      config = JSON.parse(
        await this.io.read(path.join(profile, "config.json")),
      );
    } catch {}
    if (
      config?.controlApi?.enabled !== true ||
      config?.controlApi?.allowActions !== true
    )
      throw new BridgeError(
        "control_unavailable",
        "Open Chat on Steroids and enable its local control API and actions before using automatic startup.",
      );
    const configured = this.env.COS_ACP_COS_EXE;
    // An explicitly configured binary must still be an exact CoS executable
    // name. This environment value is user-controlled and is never learned
    // from a model prompt or CoS session.
    if (
      configured &&
      path.basename(configured).toLowerCase() !== "chat on steroids.exe"
    )
      throw new BridgeError(
        "main_install_not_found",
        "COS_ACP_COS_EXE must name Chat On Steroids.exe.",
      );
    const candidates = [
      configured,
      this.env.LOCALAPPDATA &&
        path.join(
          this.env.LOCALAPPDATA,
          "Programs",
          "Chat On Steroids",
          "Chat On Steroids.exe",
        ),
      this.env.ProgramFiles &&
        path.join(
          this.env.ProgramFiles,
          "Chat On Steroids",
          "Chat On Steroids.exe",
        ),
      this.env["ProgramFiles(x86)"] &&
        path.join(
          this.env["ProgramFiles(x86)"],
          "Chat On Steroids",
          "Chat On Steroids.exe",
        ),
    ].filter((candidate): candidate is string => !!candidate);
    let exe: string | undefined;
    for (const candidate of candidates) {
      if (await this.io.file(candidate).catch(() => false)) {
        exe = candidate;
        break;
      }
    }
    if (!exe)
      throw new BridgeError(
        "main_install_not_found",
        "The main Chat on Steroids installation was not found. Open or install the official app before using this provider.",
      );
    if (this.io.now() - this.lastLaunch < 60_000)
      throw new BridgeError(
        "main_install_starting",
        "The main CoS app was already launched. Wait for it to finish starting, then refresh provider status.",
      );
    const env = { ...this.env };
    delete env.ELECTRON_RUN_AS_NODE;
    this.lastLaunch = this.io.now();
    try {
      await this.io.launch(exe, env);
    } catch {
      throw new BridgeError(
        "main_install_start_failed",
        "The main Chat on Steroids app could not be started. Open it directly, then refresh provider status.",
      );
    }
    // The normal authenticated health/identity checks still run after discovery.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await this.alive()) return;
      await this.io.wait(200);
    }
    throw new BridgeError(
      "main_install_starting",
      "The main CoS app is starting but its local control endpoint is not ready. Refresh provider status when startup finishes.",
    );
  }
}
