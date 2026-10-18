/**
 * Fail-closed source-only publication audit.
 * This deterministic preflight cannot guarantee detection of every secret.
 */
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, relative, resolve, basename } from "node:path";
import { homedir } from "node:os";

const root = resolve(import.meta.dirname, "..");
const allowedRootFiles = new Set([
  ".gitignore", "README.md", "SECURITY.md", "LICENSE",
  "package.json", "package-lock.json", "tsconfig.json",
]);
const allowedSourceDirs = new Set(["src", "test", "scripts", ".github"]);
const ignoredDevelopmentDirs = new Set([".git", "node_modules", "dist"]);
const allowedExtensions = new Set([".js", ".mjs", ".ts", ".json", ".ps1", ".md", ".yml", ".yaml", ".gitignore", ""]);
const prohibitedNames = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.aws|\.ssh|\.config|token|endpoint\.json|broker\.json|state\.sqlite|installation\.json|provider-registration\.json|.*\.(?:p8|pem|key|p12|pfx|db|sqlite|zip|bak|log))$/i;
const contentRules = [
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["GitHub access token", /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{40,}/],
  ["OpenAI-style secret", /(?:sk|sk-proj)-[A-Za-z0-9_-]{24,}/],
  ["Slack secret", /xox[baprs]-[A-Za-z0-9-]{20,}/],
  ["Google API key", /AIza[0-9A-Za-z_-]{30,}/],
  ["credential in URL", /https?:\/\/[^\/\s:@]+:[^\/\s@]+@/],
  ["email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
];
const localRoots = [
  homedir(), process.env.USERPROFILE, process.env.APPDATA, process.env.LOCALAPPDATA,
].filter((x) => typeof x === "string" && x.length >= 8);
const homeUser = basename(homedir()).toLowerCase();
const extraDeny = (process.env.COS_ACP_AUDIT_DENY ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const errors = [];
const files = [];
function visit(dir, topLevel = false) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, item.name);
    const rel = relative(root, absolute).replaceAll("\\", "/");
    if (topLevel && ignoredDevelopmentDirs.has(item.name)) continue;
    if (item.isSymbolicLink()) { errors.push(rel + ": symlink is not allowed"); continue; }
    if (item.isDirectory()) {
      if (topLevel && !allowedSourceDirs.has(item.name)) {
        errors.push(rel + ": unexpected root directory"); continue;
      }
      visit(absolute);
      continue;
    }
    if (!item.isFile() || lstatSync(absolute).size > 1024 * 1024) {
      errors.push(rel + ": unsupported/big file"); continue;
    }
    if (topLevel && !allowedRootFiles.has(item.name)) {
      errors.push(rel + ": unexpected root file"); continue;
    }
    if (prohibitedNames.test(rel)) { errors.push(rel + ": private artifact name"); continue; }
    const ext = item.name === ".gitignore" ? ".gitignore" : (item.name.match(/\.[^.]+$/)?.[0] ?? "");
    if (!allowedExtensions.has(ext)) { errors.push(rel + ": binary/unknown extension"); continue; }
    files.push({ absolute, rel });
  }
}
visit(root, true);
for (const { absolute, rel } of files) {
  const content = readFileSync(absolute, "utf8");
  if (content.includes("\uFFFD") || content.includes("\u0000")) errors.push(rel + ": non-text content");
  const normalized = content.replaceAll("\\\\", "\\").replaceAll("\\", "/").toLowerCase();
  for (const local of localRoots) {
    if (normalized.includes(local.replaceAll("\\", "/").toLowerCase())) {
      errors.push(rel + ": machine-specific home/app-data path");
    }
  }
  if (homeUser.length >= 4 && normalized.includes(homeUser)) {
    errors.push(rel + ": machine-specific user identifier");
  }
  for (const forbidden of extraDeny) {
    if (normalized.includes(forbidden.toLowerCase())) errors.push(rel + ": restricted private marker");
  }
  for (const [label, pattern] of contentRules) {
    if (pattern.test(content)) errors.push(rel + ": " + label);
  }
}
if (errors.length) {
  console.error("Public-source audit failed (" + errors.length + " findings):");
  for (const error of errors) console.error(" - " + error);
  process.exitCode = 1;
} else {
  console.log("Public-source audit passed: " + files.length + " source files; no recognized secrets, emails, host-local paths or private artifacts.");
}
