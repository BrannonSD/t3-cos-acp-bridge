import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const manifestName = 'release-manifest.json';

async function inventory(root, relative = '') {
  const result = {};
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.posix.join(relative, entry.name);
    if (name === manifestName) continue;
    const full = path.join(root, name);
    if (entry.isSymbolicLink() || (await lstat(full)).isSymbolicLink()) throw new Error('Release contains a symbolic link');
    if (entry.isDirectory()) Object.assign(result, await inventory(root, name));
    else if (entry.isFile()) result[name] = sha256(await readFile(full));
    else throw new Error('Release contains an unsupported file');
  }
  return result;
}

export async function createManifest(directory, revision, nodePath) {
  if (!/^[0-9a-f]{7,40}$/.test(revision)) throw new Error('A committed source revision is required');
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const nodeMajor = Number(String(pkg.engines?.node ?? '').match(/\d+/)?.[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 1) throw new Error('package.json must declare a supported Node major');
  const manifest = {
    schema: 1,
    package: pkg.name,
    version: pkg.version,
    revision,
    nodeMajor,
    nodeSha256: sha256(await readFile(nodePath)),
    stateSchema: { min: 0, max: 1 },
    controlProtocols: [1],
    acpSdk: pkg.dependencies['@agentclientprotocol/sdk'],
    files: await inventory(directory)
  };
  await writeFile(path.join(directory, manifestName), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

export async function verifyRelease(directory, nodePath) {
  const manifest = JSON.parse(await readFile(path.join(directory, manifestName), 'utf8'));
  if (manifest.schema !== 1 || typeof manifest.revision !== 'string' ||
      !manifest.stateSchema || !Number.isInteger(manifest.stateSchema.min) ||
      !Number.isInteger(manifest.stateSchema.max) || manifest.stateSchema.min < 0 ||
      manifest.stateSchema.max < manifest.stateSchema.min ||
      !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new Error('Unsupported or incomplete release manifest');
  }
  if (manifest.nodeSha256 !== sha256(await readFile(nodePath))) throw new Error('Node runtime changed; validate compatibility before activation');
  const actual = await inventory(directory);
  const expectedNames = Object.keys(manifest.files).sort();
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(expectedNames)) throw new Error('Release file inventory changed');
  for (const name of expectedNames) {
    if (actual[name] !== manifest.files[name]) throw new Error('Release file checksum mismatch');
  }
  return manifest;
}

/** This reads adapter state only; CoS's profile and T3's database are never opened. */
export function checkStateForSwitch(databasePath, manifest) {
  if (!Number.isInteger(manifest.stateSchema?.min) || !Number.isInteger(manifest.stateSchema?.max) ||
      manifest.stateSchema.min < 0 || manifest.stateSchema.max < manifest.stateSchema.min) {
    throw new Error('Unsupported state schema range');
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const version = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (version < manifest.stateSchema.min || version > manifest.stateSchema.max) throw new Error('Adapter state schema is incompatible with this release');
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='operations'").get();
    if (table) {
      const unsettled = db.prepare("SELECT COUNT(*) AS count FROM operations WHERE json_extract(body,'$.phase') IN ('prepared','admitted','uncertain')").get();
      if (Number(unsettled.count) > 0) throw new Error('Unsettled ChatGPT inputs must be reconciled before changing releases');
    }
    return { schema: version };
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, directory, nodePath, extra] = process.argv.slice(2);
    if (!directory || !nodePath) throw new Error('Expected release directory and absolute Node path');
    if (command === 'create') await createManifest(directory, extra, nodePath);
    else if (command === 'verify') await verifyRelease(directory, nodePath);
    else if (command === 'preflight') {
      const manifest = await verifyRelease(directory, nodePath);
      if (extra) checkStateForSwitch(extra, manifest);
    } else throw new Error('Unknown release operation');
    process.stdout.write('Release compatibility and integrity checks passed.\n');
  } catch (error) {
    process.stderr.write(String(error instanceof Error ? error.message : 'Release validation failed') + '\n');
    process.exitCode = 1;
  }
}
