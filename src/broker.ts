import net from "node:net";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, unlink, open } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BridgeError, type BrokerResponse } from "./contracts.js";
import { Control } from "./control.js";
import { Engine, sleep } from "./engine.js";
import { Store } from "./store.js";
import { integrationMode, type IntegrationMode } from "./compatibility.js";
import { launchOutsideTree } from "./windows-launch.js";
export const stateDirectory = () =>
  process.env.COS_ACP_HOME ??
  path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share"),
    "T3-CoS-Integration",
    "state",
  );
export const controlDirectory = () =>
  process.env.COS_USER_DATA
    ? path.join(process.env.COS_USER_DATA, "control-api")
    : path.join(
        process.env.APPDATA ?? path.join(os.homedir(), ".config"),
        "chat-on-steroids",
        "control-api",
      );
interface Discovery {
  pipe: string;
  token: string;
  pid: number;
  version: 1;
  integrationMode?: IntegrationMode;
  autoStartMain?: boolean;
  adapterPath: string;
  nodePath: string;
  controlDirectory: string;
}
const discoveryFile = (directory: string) =>
  path.join(directory, "broker.json");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
export async function serve(directory = stateDirectory()) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(directory, "broker.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    const pid = Number(await readFile(lockPath, "utf8").catch(() => ""));
    if (pid && alive(pid)) return;
    await unlink(lockPath).catch(() => undefined);
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch {
      return;
    }
  }
  await lock.writeFile(String(process.pid));
  await lock.close();
  const pipe =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cos-acp-${createHash("sha256").update(directory).digest("hex").slice(0, 24)}`
      : path.join(directory, "broker.sock");
  if (process.platform !== "win32") await unlink(pipe).catch(() => undefined);
  const token = randomBytes(32).toString("base64url");
  const store = new Store(directory);
  const engine = new Engine(store, new Control(controlDirectory()));
  let sockets = 0;
  let touched = Date.now();
  const server = net.createServer((socket) => {
    if (sockets >= 64) {
      socket.destroy();
      return;
    }
    sockets++;
    let buffer = "";
    let handled = false;
    const timeout = setTimeout(() => socket.destroy(), 30_000);
    socket.on("close", () => {
      sockets--;
      clearTimeout(timeout);
    });
    socket.on("error", () => undefined);
    socket.on("data", (bytes) => {
      buffer += bytes.toString();
      if (buffer.length > 24 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      if (handled || !buffer.includes("\n")) return;
      handled = true;
      void (async () => {
        let reply: BrokerResponse;
        try {
          const call = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as {
            token: string;
            method: string;
            params?: Record<string, unknown>;
          };
          const given = Buffer.from(call.token ?? "");
          const expected = Buffer.from(token);
          if (
            given.length !== expected.length ||
            !timingSafeEqual(given, expected)
          )
            throw new BridgeError(
              "unauthorized",
              "Bridge authentication failed.",
            );
          touched = Date.now();
          reply = { result: await engine.dispatch(call.method, call.params) };
        } catch (error) {
          reply = {
            error: {
              code: error instanceof BridgeError ? error.code : "bridge_error",
              message:
                error instanceof BridgeError
                  ? error.message
                  : "The local integration service could not complete this operation.",
            },
          };
        }
        socket.end(JSON.stringify(reply) + "\n");
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipe, () => resolve());
  });
  await writeFile(
    discoveryFile(directory),
    JSON.stringify({
      pipe,
      token,
      pid: process.pid,
      version: 1,
      integrationMode: integrationMode(),
      autoStartMain: process.env.COS_ACP_AUTOSTART === "1",
      adapterPath: fileURLToPath(new URL("./cli.js", import.meta.url)),
      nodePath: process.execPath,
      controlDirectory: path.resolve(controlDirectory()),
    } satisfies Discovery),
    { mode: 0o600 },
  );
  for (const session of store.sessions())
    if (session.activeInput) engine.watch(session);
  const close = () => {
    engine.close();
    server.close();
    void unlink(discoveryFile(directory)).catch(() => undefined);
    void unlink(lockPath).catch(() => undefined);
    clearInterval(idle);
    setTimeout(() => process.exit(0), 200).unref();
  };
  const idle = setInterval(() => {
    if (!sockets && !engine.polling.size && Date.now() - touched > 120_000)
      close();
  }, 30_000);
  idle.unref();
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}
export class BrokerClient {
  constructor(readonly directory = stateDirectory()) {}
  private compatible(found: Discovery): Discovery {
    if (found.version !== 1 || !found.token || !alive(found.pid))
      throw new Error("stale broker");
    const same = (a: string | undefined, b: string) =>
      a !== undefined &&
      (process.platform === "win32"
        ? a.toLowerCase() === b.toLowerCase()
        : a === b);
    if (
      (found.integrationMode ?? "modern") !== integrationMode() ||
      (found.autoStartMain ?? false) !==
        (process.env.COS_ACP_AUTOSTART === "1") ||
      !same(
        found.adapterPath,
        fileURLToPath(new URL("./cli.js", import.meta.url)),
      ) ||
      !same(found.nodePath, process.execPath) ||
      !same(found.controlDirectory, path.resolve(controlDirectory()))
    )
      throw new BridgeError(
        "broker_configuration_mismatch",
        "An integration broker is already running for another release, runtime, CoS profile, or compatibility mode. Finish active operations and let it exit before switching, or use a separate private adapter state directory. CoS need not restart.",
      );
    return found;
  }
  private async discover(): Promise<Discovery> {
    try {
      const found = JSON.parse(
        await readFile(discoveryFile(this.directory), "utf8"),
      ) as Discovery;
      return this.compatible(found);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const args = [
      "--disable-warning=ExperimentalWarning",
      fileURLToPath(new URL("./cli.js", import.meta.url)),
      "--broker",
    ];
    if (process.platform === "win32") {
      // A disposable T3 probe is killed with its descendants. The shared broker
      // must survive that cleanup so concurrent probes/threads retain one owner.
      const environment: Record<string, string> = {
        COS_ACP_HOME: this.directory,
      };
      for (const key of [
        "COS_ACP_MODE",
        "COS_ACP_AUTOSTART",
        "COS_USER_DATA",
        "COS_ACP_COS_EXE",
        "COS_ACP_TEST",
      ])
        if (process.env[key] !== undefined)
          environment[key] = process.env[key]!;
      await launchOutsideTree(process.execPath, args, environment);
    } else {
      const child = spawn(process.execPath, args, {
        env: { ...process.env, COS_ACP_HOME: this.directory },
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    }
    // Cold Windows Node startup can exceed five seconds under build/test load.
    // Keep the discovery deadline below T3's request timeout.
    for (let i = 0; i < 150; i++) {
      await sleep(100);
      try {
        const found = JSON.parse(
          await readFile(discoveryFile(this.directory), "utf8"),
        ) as Discovery;
        return this.compatible(found);
      } catch (error) {
        if (error instanceof BridgeError) throw error;
      }
    }
    throw new BridgeError(
      "broker_unavailable",
      "Chat on Steroids integration could not start its local service.",
    );
  }
  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const found = await this.discover();
    return new Promise<T>((resolve, reject) => {
      const socket = net.connect(found.pipe);
      let buffer = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new BridgeError(
            "broker_timeout",
            "The local operation is unconfirmed. Resume the same session to reconcile it.",
          ),
        );
      }, 30_000);
      socket.once("connect", () =>
        socket.write(
          JSON.stringify({ token: found.token, method, params }) + "\n",
        ),
      );
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        if (buffer.length > 24 * 1024 * 1024) {
          socket.destroy();
          reject(
            new BridgeError(
              "oversized_response",
              "The local service response exceeded its limit.",
            ),
          );
        }
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(
          new BridgeError(
            "broker_unavailable",
            "The local integration service disconnected. Resume the same session.",
          ),
        );
      });
      socket.once("end", () => {
        clearTimeout(timer);
        try {
          const reply = JSON.parse(buffer) as BrokerResponse;
          if (reply.error)
            reject(new BridgeError(reply.error.code, reply.error.message));
          else resolve(reply.result as T);
        } catch {
          reject(
            new BridgeError(
              "broker_protocol",
              "The local integration service returned an invalid response.",
            ),
          );
        }
      });
    });
  }
}
