/**
 * Windows registry auto-install for the companion Chromium extension.
 *
 * One click in Settings → Browser integration lands the already-packed
 * `tiri.crx` by writing `HKCU\Software\<Vendor>\...\Extensions\<id>` with
 * `path` and `version` REG_SZ values. This is only a registration request:
 * Chromium may block the local CRX, and registry state cannot confirm that a
 * browser loaded or enabled the extension. Never report registration as install.
 *
 * Structure is deliberate: `buildRegCommands` is pure and unit-tested, real
 * side effects (filesystem copies, `reg.exe`) live behind explicit `write`
 * calls, and every Windows-only path no-ops cleanly on other platforms.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join, win32 } from 'node:path'
import { z } from 'zod'
import { parseOrThrow } from '@shared/schemas.js'
import type {
  ExtensionBrowserId,
  ExtensionBrowserState,
  ExtensionStatusResult,
  InstallExtensionResult,
  InstallPerBrowserResult
} from '@shared/ipc.js'
import { getLogger } from '../util/logger.js'
import { resolveWithin } from '../util/paths.js'

const log = getLogger('extensionInstall')

/** Where the packed artefacts live: `%APPDATA%\moth-dlm\extension-key\` etc. */
const APP_DIR_NAME = 'moth-dlm'
const STABLE_DIR_NAME = 'extension'
const CRX_FILE_NAME = 'tiri.crx'
const ID_FILE_NAME = 'extension-id.txt'

const extensionIdSchema = z
  .string()
  .length(32)
  .regex(/^[a-p]{32}$/, 'Extension ID must be 32 lowercase a-p characters')

const crxPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => win32.isAbsolute(value) && value.toLowerCase().endsWith('.crx'),
    'CRX path must be an absolute Windows path ending in .crx'
  )

const extensionVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(\.\d+)?$/, 'Extension version must look like 1.0.0')

interface BrowserDef {
  id: ExtensionBrowserId
  label: string
  /** Registry root below HKCU holding the per-extension keys. */
  registryRoot: string
  /** exe location relative to each program-files-style base directory. */
  exeSubPath: string
}

export const BROWSER_DEFS: readonly BrowserDef[] = [
  {
    id: 'chrome',
    label: 'Chrome',
    registryRoot: 'Software\\Google\\Chrome\\Extensions',
    exeSubPath: 'Google\\Chrome\\Application\\chrome.exe'
  },
  {
    id: 'edge',
    label: 'Microsoft Edge',
    registryRoot: 'Software\\Microsoft\\Edge\\Extensions',
    exeSubPath: 'Microsoft\\Edge\\Application\\msedge.exe'
  },
  // Brave moved off Chrome's key with brave/brave-browser#37939; very old
  // Brave builds read Software\Google\Chrome\Extensions instead and will not
  // see this entry. Chrome itself must never be written for Brave's sake.
  {
    id: 'brave',
    label: 'Brave',
    registryRoot: 'Software\\BraveSoftware\\Brave\\Extensions',
    exeSubPath: 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'
  }
]

export function browserDef(browser: ExtensionBrowserId): BrowserDef {
  const def = BROWSER_DEFS.find((candidate) => candidate.id === browser)
  if (!def) throw new Error(`Unknown Chromium browser: ${browser}`)
  return def
}

/** Absolute candidate exe paths for `browser`, derived from `env`. Pure. */
export function candidateExePaths(
  browser: ExtensionBrowserId,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const bases = [env['ProgramFiles'], env['ProgramFiles(x86)'], env['LOCALAPPDATA']].filter(
    (base): base is string => typeof base === 'string' && base.length > 0
  )
  const sub = browserDef(browser).exeSubPath
  return bases.map((base) => win32.join(base, sub))
}

/** Which of the known browsers look installed. `exists` is injected for tests. */
export function detectBrowsers(
  exists: (path: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env
): ExtensionBrowserId[] {
  return BROWSER_DEFS.filter((def) =>
    candidateExePaths(def.id, env).some((candidate) => {
      try {
        return exists(candidate)
      } catch {
        return false
      }
    })
  ).map((def) => def.id)
}

export interface RegValue {
  name: 'path' | 'version'
  type: 'REG_SZ'
  data: string
}

export interface RegCommand {
  browser: ExtensionBrowserId
  /** Full key in `reg.exe` notation, e.g. `HKCU\Software\...\Extensions\<id>`. */
  key: string
  values: RegValue[]
}

/**
 * Pure command builder: the exact registry writes for every known browser.
 * Validates its inputs and never touches the machine. Unit-tested.
 */
export function buildRegCommands(id: string, crxPath: string, version: string): RegCommand[] {
  const extensionId = parseOrThrow(extensionIdSchema, id, 'extension id')
  const crx = parseOrThrow(crxPathSchema, crxPath, 'extension path')
  const extVersion = parseOrThrow(extensionVersionSchema, version, 'extension version')
  return BROWSER_DEFS.map((def) => ({
    browser: def.id,
    key: `HKCU\\${def.registryRoot}\\${extensionId}`,
    values: [
      { name: 'path', type: 'REG_SZ', data: crx },
      { name: 'version', type: 'REG_SZ', data: extVersion }
    ]
  }))
}

/** Lowers one `RegCommand` to the `reg.exe add …` argv lists that enact it. */
export function toRegAddArgs(command: RegCommand): string[][] {
  return command.values.map((value) => [
    'add',
    command.key,
    '/v',
    value.name,
    '/t',
    value.type,
    '/d',
    value.data,
    '/f'
  ])
}

/** Parses the data out of `reg.exe query … /v <name>` output. Pure. */
export function parseRegSz(output: string): string | null {
  for (const line of output.split('\n')) {
    const match = /REG_SZ\s+(.+?)\s*$/.exec(line)
    if (match?.[1]) return match[1].trim()
  }
  return null
}

function runReg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('reg.exe', args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`reg.exe ${args[0] ?? ''} failed: ${(stderr || error.message).trim()}`))
        return
      }
      resolve(stdout)
    })
  })
}

export interface ExtensionEnv {
  /** `%APPDATA%` — the stable install location hangs off this, not off `release\`. */
  appDataDir: string
  /** Packaged `<resources>/assets`, or `<repo>/resources` in development. */
  resourcesDir: string
}

/** Packaged builds ship `assets/browser-extension/`; dev reads the repo tree. */
export function candidateAssetDirs(resourcesDir: string): string[] {
  return [join(resourcesDir, 'browser-extension'), join(resourcesDir, '..', 'browser-extension')]
}

async function findAsset(
  resourcesDir: string,
  relativePath: string
): Promise<{ path: string; content: string } | null> {
  for (const dir of candidateAssetDirs(resourcesDir)) {
    // Segments are constants, never renderer input; join cannot escape here,
    // but the read is still confined to one of the two known asset roots.
    const full = join(dir, relativePath)
    try {
      return { path: full, content: await readFile(full, 'utf8') }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  return null
}

/** The packed identity: ID from `packExtension.mjs`, version from the manifest. */
export async function readExtensionIdentity(
  resourcesDir: string
): Promise<{ id: string; version: string; crxSource: string } | null> {
  const idFile = await findAsset(resourcesDir, ID_FILE_NAME)
  const manifestFile = await findAsset(resourcesDir, join('chrome', 'manifest.json'))
  if (!idFile || !manifestFile) return null
  const id = parseOrThrow(extensionIdSchema, idFile.content.trim(), 'packed extension id')
  let rawVersion: unknown
  try {
    rawVersion = (JSON.parse(manifestFile.content) as { version?: unknown }).version
  } catch {
    throw new Error(`Extension manifest is not valid JSON: ${manifestFile.path}`)
  }
  const version = parseOrThrow(extensionVersionSchema, rawVersion, 'extension manifest version')
  const crxSource = join(dirname(manifestFile.path), '..', CRX_FILE_NAME)
  try {
    await readFile(crxSource)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  return { id, version, crxSource }
}

/**
 * Versioned stable path for the `.crx`: `%APPDATA%\moth-dlm\extension\tiri.crx`.
 * Registry `path` values must never point into `release\` or temp, which move.
 */
export function getStableCrxPath(appDataDir: string): string {
  return resolveWithin(appDataDir, APP_DIR_NAME, STABLE_DIR_NAME, CRX_FILE_NAME)
}

async function queryRegValue(key: string, name: 'path' | 'version'): Promise<string | null> {
  try {
    return parseRegSz(await runReg(['query', key, '/v', name]))
  } catch {
    // Missing key (or unreadable hive): the browser simply has no entry.
    return null
  }
}

async function browserState(
  def: BrowserDef,
  detected: readonly ExtensionBrowserId[],
  identity: { id: string; version: string } | null,
  stableCrx: string
): Promise<ExtensionBrowserState> {
  const currentVersion = identity?.version ?? null
  if (!identity) {
    return {
      browser: def.id,
      label: def.label,
      detected: detected.includes(def.id),
      registered: false,
      registeredVersion: null,
      currentVersion
    }
  }
  const key = `HKCU\\${def.registryRoot}\\${identity.id}`
  const [registeredPath, registeredVersion] = await Promise.all([
    queryRegValue(key, 'path'),
    queryRegValue(key, 'version')
  ])
  return {
    browser: def.id,
    label: def.label,
    detected: detected.includes(def.id),
    registered:
      registeredVersion === identity.version &&
      registeredPath?.toLowerCase() === stableCrx.toLowerCase(),
    registeredVersion,
    currentVersion
  }
}

export async function getExtensionStatus(env: ExtensionEnv): Promise<ExtensionStatusResult> {
  if (process.platform !== 'win32') {
    return { supported: false, packaged: false, extensionId: null, browsers: [] }
  }
  const identity = await readExtensionIdentity(env.resourcesDir).catch((err: unknown) => {
    log.warn('Extension identity unreadable', { error: err })
    return null
  })
  const stableCrx = getStableCrxPath(env.appDataDir)
  const detected = detectBrowsers()
  const browsers: ExtensionBrowserState[] = []
  for (const def of BROWSER_DEFS) {
    browsers.push(await browserState(def, detected, identity, stableCrx))
  }
  return {
    supported: true,
    packaged: identity !== null,
    extensionId: identity?.id ?? null,
    browsers
  }
}

export async function installExtension(
  env: ExtensionEnv & { browsers?: ExtensionBrowserId[] }
): Promise<InstallExtensionResult> {
  if (process.platform !== 'win32') {
    return { supported: false, crxPath: null, results: [], restartRequired: false }
  }
  const identity = await readExtensionIdentity(env.resourcesDir)
  if (!identity) {
    throw new Error(
      'The packed extension is missing (no tiri.crx / extension-id.txt alongside the app). ' +
        'Run `npm run pack:extension` on a machine with Chrome, then rebuild.'
    )
  }

  // Stage to the stable location first: the registry must reference a path
  // that survives updates, not the build tree or a temp dir.
  const stableCrx = getStableCrxPath(env.appDataDir)
  await mkdir(dirname(stableCrx), { recursive: true })
  await copyFile(identity.crxSource, stableCrx)
  log.info('Staged extension for registry install', { crx: stableCrx, version: identity.version })

  const wanted = env.browsers && env.browsers.length > 0 ? env.browsers : detectBrowsers()
  const commands = buildRegCommands(identity.id, stableCrx, identity.version).filter((command) =>
    wanted.includes(command.browser)
  )

  const results: InstallPerBrowserResult[] = []
  for (const command of commands) {
    const label = browserDef(command.browser).label
    try {
      for (const args of toRegAddArgs(command)) {
        await runReg(args)
      }
      log.info('Registered extension with browser', { browser: command.browser })
      results.push({ browser: command.browser, label, ok: true, error: null })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('Registry write failed', { browser: command.browser, error: message })
      results.push({ browser: command.browser, label, ok: false, error: message })
    }
  }
  return {
    supported: true,
    crxPath: stableCrx,
    results,
    restartRequired: results.some((result) => result.ok)
  }
}
