/**
 * Packs browser-extension/chrome/ into a signed .crx for registry-based install.
 *
 * Usage:
 *   node scripts/packExtension.mjs [--init-key] [--key=<pem>] [--chrome=<exe>] [--out=<crx>]
 *
 * The .pem key is generated ONCE (first run with --init-key, or bring your own
 * via --key) and lives OUTSIDE the repo at %APPDATA%\moth-dlm\extension-key\.
 * The extension ID derives from that key, so key stability = ID stability.
 * Losing the key means a new identity: every user would see a *different*
 * extension and have to enable it again. Back it up.
 *
 * Requires a locally installed Chrome (chrome.exe --pack-extension). If Chrome
 * is absent the script fails loudly and never writes anything.
 */

import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(REPO_ROOT, 'browser-extension', 'chrome');
const ID_FILE = join(REPO_ROOT, 'browser-extension', 'extension-id.txt');

const DEFAULT_KEY_PATH =
  process.env['MOTH_EXTENSION_KEY'] ??
  join(
    process.env['APPDATA'] ?? join(tmpdir(), 'moth-dlm-fallback'),
    'moth-dlm',
    'extension-key',
    'moth.pem',
  );

function argValue(name) {
  const prefix = `--${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function fail(message) {
  console.error(`\npackExtension: ERROR: ${message}\n`);
  process.exit(1);
}

/** Where chrome.exe lives on this machine, or null when Chrome is absent. */
function findChrome(override) {
  const candidates = [];
  if (override) candidates.push(override);
  if (process.env['CHROME_PATH']) candidates.push(process.env['CHROME_PATH']);
  const programFiles = process.env['ProgramFiles'];
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  const localAppData = process.env['LOCALAPPDATA'];
  if (programFiles) candidates.push(join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (programFilesX86)
    candidates.push(join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (localAppData)
    candidates.push(join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The documented extension-ID algorithm: SHA-256 of the public key's DER
 * encoding, first 128 bits, each nibble mapped to a letter a-p.
 */
function extensionIdFromPem(pemText) {
  let publicDer;
  try {
    publicDer = createPublicKey(pemText).export({ type: 'spki', format: 'der' });
  } catch {
    fail('The key file is not a valid PEM private key. Delete it and re-run with --init-key.');
  }
  const digest = createHash('sha256').update(publicDer).digest();
  let id = '';
  for (let i = 0; i < 16; i += 1) {
    const byte = digest[i];
    id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f));
  }
  return id;
}

/** Generates the once-ever keypair with Node's CSPRNG and stores it privately. */
function initKey(keyPath) {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  // PKCS#8 ("BEGIN PRIVATE KEY"): the only PEM flavour chrome.exe accepts
  // for --pack-extension-key. PKCS#1 is rejected with exit 22.
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSyncPrivate(keyPath, pem);
  console.log(`Generated a new extension key (once-ever identity):\n  ${keyPath}`);
  console.log('Back it up. Losing it means a new extension ID for every user.');
}

function writeFileSyncPrivate(path, text) {
  // Best effort: key material should not be world-readable.
  writeFileSync(path, text, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows ACLs ignore POSIX modes; nothing more to do. */
  }
}

function runChromePack(chromeExe, extensionDir, keyPathOrNull) {
  const args = [`--pack-extension=${extensionDir}`];
  if (keyPathOrNull) args.push(`--pack-extension-key=${keyPathOrNull}`);
  // NOTE: --pack-extension ignores cwd. Chrome always drops
  // <parent>/<dirname>.crx next to the extension directory.
  const result = spawnSync(chromeExe, args, { encoding: 'utf8' });
  if (result.error) fail(`Could not launch Chrome (${chromeExe}): ${result.error.message}`);
  if (result.status !== 0) {
    fail(`chrome.exe --pack-extension failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
  return join(dirname(extensionDir), `${basename(extensionDir)}.crx`);
}

async function main() {
  if (process.platform !== 'win32') {
    fail('Packing is a Windows-only step (it shells out to chrome.exe with Windows paths).');
  }
  if (!existsSync(EXTENSION_DIR)) fail(`Extension source missing: ${EXTENSION_DIR}`);
  if (!existsSync(join(EXTENSION_DIR, 'manifest.json')))
    fail(`No manifest.json in ${EXTENSION_DIR}; refusing to pack the wrong directory.`);

  const keyPath = resolve(argValue('key') ?? DEFAULT_KEY_PATH);
  const chromeExe = findChrome(argValue('chrome'));
  if (!chromeExe) {
    fail(
      'No Chrome installation found. Install Google Chrome, or pass --chrome=<path to chrome.exe> ' +
        '(CHROME_PATH also works). Nothing was packed.',
    );
  }

  if (!existsSync(keyPath)) {
    if (!hasFlag('init-key')) {
      fail(
        `No extension key at ${keyPath}.\n` +
          'The key is the extension\'s long-term identity and is created exactly once. ' +
          'Re-run with --init-key to generate it (stored outside the repo), then pack again.',
      );
    }
    initKey(keyPath);
  }

  // Sanity: the key must parse before Chrome ever sees it.
  const pemText = await readFile(keyPath, 'utf8');
  const extensionId = extensionIdFromPem(pemText);

  const outCrx = resolve(argValue('out') ?? join(REPO_ROOT, 'browser-extension', 'tiri.crx'));
  if (!isAbsolute(outCrx) || !outCrx.toLowerCase().endsWith('.crx')) {
    fail(`--out must be an absolute path ending in .crx (got ${outCrx}).`);
  }

  const packedTmp = runChromePack(chromeExe, EXTENSION_DIR, keyPath);
  if (!existsSync(packedTmp)) {
    fail(
      `Chrome reported success but ${packedTmp} is missing. ` +
        'Is another Chrome instance locking the profile? Close Chrome and retry.',
    );
  }
  mkdirSync(dirname(outCrx), { recursive: true });
  rmSync(outCrx, { force: true });
  renameSync(packedTmp, outCrx);
  // Chrome may drop a stray .pem next to the output when no key is given; with
  // --pack-extension-key it does not, but belt and braces: never leave key
  // material in the repo tree.
  rmSync(packedTmp.replace(/\.crx$/i, '.pem'), { force: true });

  // The ID is public (it ships in the registry and the .crx), the key is not.
  // Recording it lets the app and future packs verify they agree on identity.
  if (existsSync(ID_FILE)) {
    const recorded = (await readFile(ID_FILE, 'utf8')).trim();
    if (recorded !== extensionId) {
      fail(
        `Key/identity mismatch: the key derives ID ${extensionId} but ${ID_FILE} records ${recorded}.\n` +
          'You are packing with a DIFFERENT key than the released extension. ' +
          'Point --key at the original key (check the backup), or accept a new ' +
          `identity by deleting ${ID_FILE} and re-running.`,
      );
    }
  } else {
    await writeFile(ID_FILE, `${extensionId}\n`, 'utf8');
  }

  const manifest = JSON.parse(await readFile(join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
  console.log('\nPacked successfully:');
  console.log(`  crx:     ${outCrx}`);
  console.log(`  id:      ${extensionId}`);
  console.log(`  version: ${manifest.version ?? '(unreadable)'}`);
  console.log(`  key:     ${keyPath} (outside the repo; never commit it)`);
  console.log('\nNext: restart Chrome to pick the extension up after registry install.');
}

await main();
