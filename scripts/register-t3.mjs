#!/usr/bin/env node
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const object = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export function mergeRegistration(settings, registration, native = false) {
  if (
    !object(settings) ||
    !object(registration) ||
    !object(registration.providerInstances) ||
    !object(registration.providerInstances.chat_on_steroids)
  ) {
    throw new Error("Invalid T3 settings or provider registration.");
  }
  const provider = structuredClone(
    registration.providerInstances.chat_on_steroids,
  );
  if (
    provider.driver !== "acpRegistry" ||
    provider.config?.source !== "local" ||
    typeof provider.config.commandPath !== "string" ||
    !Array.isArray(provider.config.commandArgs)
  ) {
    throw new Error("Only a validated local ACP provider may be registered.");
  }
  if (!native) delete provider.config.integration;
  const previous = settings.providerInstances?.chat_on_steroids;
  if (
    previous?.enabled &&
    previous.config?.commandArgs?.[1] !== provider.config.commandArgs[1]
  ) {
    throw new Error(
      "Disable Chat on Steroids in T3 and drain active inputs before switching releases.",
    );
  }
  const result = structuredClone(settings);
  result.providerInstances = {
    ...(result.providerInstances ?? {}),
    chat_on_steroids: provider,
  };
  return result;
}
export async function registerT3(
  settingsPath,
  registrationPath,
  native = false,
) {
  const before = await readFile(settingsPath, "utf8");
  const settings = JSON.parse(before.replace(/^\uFEFF/, ""));
  const registration = JSON.parse(
    (await readFile(registrationPath, "utf8")).replace(/^\uFEFF/, ""),
  );
  const updated = mergeRegistration(settings, registration, native);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = settingsPath + ".before-cos-register-" + stamp + ".bak";
  const tmp = settingsPath + ".tmp-cos-register-" + process.pid;
  // The canonical adapter release already passed its separate, mandatory
  // immutable-manifest and unsettled-input preflight. This registration step
  // refuses hot switching an enabled provider and preserves all other settings.
  await writeFile(backup, before, { flag: "wx" });
  try {
    await writeFile(tmp, JSON.stringify(updated, null, 2) + "\n", {
      flag: "wx",
    });
    if ((await readFile(settingsPath, "utf8")) !== before) {
      throw new Error(
        "Concurrent T3 settings change. Refusing to overwrite it.",
      );
    }
    await rename(tmp, settingsPath);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
  return { settingsPath, backup, native };
}
const asScript =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (asScript) {
  const args = process.argv.slice(2);
  const home = process.env.USERPROFILE ?? os.homedir();
  const settings =
    args.find((a) => a.startsWith("--settings="))?.slice(11) ??
    path.join(home, ".t3", "userdata", "settings.json");
  const registration =
    args.find((a) => a.startsWith("--registration="))?.slice(15) ??
    path.join(
      process.env.LOCALAPPDATA ?? home,
      "T3-CoS-Integration",
      "provider-registration.json",
    );
  try {
    const result = await registerT3(
      settings,
      registration,
      args.includes("--native"),
    );
    process.stdout.write(
      "Registered CoS ACP provider in T3 settings; backup: " +
        result.backup +
        "\n",
    );
  } catch (error) {
    process.stderr.write(
      (error instanceof Error ? error.message : "T3 registration failed") +
        "\n",
    );
    process.exitCode = 1;
  }
}
