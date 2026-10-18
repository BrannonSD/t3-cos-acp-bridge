import { execFile } from "node:child_process";
import { promisify } from "node:util";
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
// Start-Process reparses ArgumentList as a Windows command line.
const argument = (value: string) =>
  `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
export function shellLaunchScript(
  exe: string,
  args: string[] = [],
  environment: Record<string, string> = {},
) {
  const assignments = Object.entries(environment)
    .map(([key, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key))
        throw Error("Invalid launch environment key");
      return `$env:${key}=${literal(value)}; `;
    })
    .join("");
  // Explorer owns the new process tree; taskkill /T on a T3 probe cannot kill it.
  const payload = `$env:ELECTRON_RUN_AS_NODE=$null; ${assignments}Start-Process -FilePath ${literal(exe)}${args.length ? ` -ArgumentList ${literal(args.map(argument).join(" "))}` : ""} -WindowStyle Hidden`;
  const encoded = Buffer.from(payload, "utf16le").toString("base64");
  return `$ErrorActionPreference='Stop'; $shell=New-Object -ComObject Shell.Application; $shell.ShellExecute('powershell.exe','-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}','','open',0)`;
}
export async function launchOutsideTree(
  exe: string,
  args: string[] = [],
  environment: Record<string, string> = {},
) {
  await promisify(execFile)(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      shellLaunchScript(exe, args, environment),
    ],
    { windowsHide: true, timeout: 10_000 },
  );
}
