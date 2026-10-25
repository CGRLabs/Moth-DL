import { randomBytes, randomInt } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { EngineError } from '../util/errors.js'
import { getLogger } from '../util/logger.js'
import { z } from 'zod'

const log = getLogger('torrent.transmission')
const RPC_TIMEOUT_MS = 5000
const START_TIMEOUT_MS = 15000
const START_POLL_MS = 250

export function transmissionLimit(
  bytesPerSecond: number | null | undefined,
  label: string
): {
  limited: boolean
  kilobytesPerSecond: number
  bytesPerSecond: number | null
} {
  if (bytesPerSecond === null || bytesPerSecond === undefined || bytesPerSecond <= 0) {
    return { limited: false, kilobytesPerSecond: 0, bytesPerSecond: null }
  }
  if (bytesPerSecond < 1024) {
    throw new EngineError({
      code: 'PRECONDITION_FAILED',
      message: `Transmission ${label} limits must be at least 1 KiB/s`,
      retryable: false
    })
  }
  const kilobytesPerSecond = Math.floor(bytesPerSecond / 1024)
  return {
    limited: true,
    kilobytesPerSecond,
    bytesPerSecond: kilobytesPerSecond * 1024
  }
}

export function getBundledTransmissionExecutable(
  resourcesDirectory: string,
  platform = process.platform,
  architecture = process.arch
): string | null {
  if (platform !== 'win32' || architecture !== 'x64' || !resourcesDirectory) return null
  return join(resourcesDirectory, 'transmission', 'win-x64', 'transmission-daemon.exe')
}

export function getTorrentMetainfoPath(downloadId: string, downloadDirectory: string): string {
  const directory = resolve(downloadDirectory)
  if (
    !/^[A-Za-z0-9_-]+$/.test(downloadId) ||
    basename(directory) !== downloadId ||
    basename(dirname(directory)) !== '.moth-torrents'
  ) {
    throw new EngineError({
      code: 'PRECONDITION_FAILED',
      message: 'Refusing to access torrent metainfo outside its managed download path',
      retryable: false
    })
  }
  return join(dirname(directory), `${downloadId}.torrent`)
}

export interface TransmissionTorrent {
  id: number
  hashString: string
  name: string
  status: number
  percentDone: number
  totalSize: number
  sizeWhenDone: number
  haveValid: number
  rateDownload: number
  leftUntilDone: number
  downloadDir: string
  peersConnected: number
  isFinished: boolean
}

export interface TransmissionRpc {
  call(method: string, args?: Record<string, unknown>): Promise<unknown>
}

export interface TransmissionClientProvider {
  start(): Promise<TransmissionRpc>
}

interface SessionCredentials {
  port: number
  username: string
  password: string
}

const credentialsSchema = z.object({
  port: z.number().int().min(1024).max(65535),
  username: z.string().min(1).max(128),
  password: z.string().min(32).max(256)
})

const torrentSchema = z.object({
  id: z.number().int().nonnegative(),
  hashString: z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/i),
  name: z.string().min(1).max(4096),
  status: z.number().int().min(0).max(6),
  percentDone: z.number().finite().min(0).max(1),
  totalSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sizeWhenDone: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  haveValid: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  rateDownload: z.number().finite().nonnegative(),
  leftUntilDone: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  downloadDir: z.string().min(1).max(4096),
  peersConnected: z.number().int().nonnegative(),
  isFinished: z.boolean()
})

const addedTorrentSchema = z.object({
  id: z.number().int().nonnegative(),
  hashString: z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/i)
})

const torrentFilesSchema = z.object({
  files: z.array(z.object({
    name: z.string().min(1).max(16_384),
    length: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    bytesCompleted: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })).max(100_000),
  fileStats: z.array(z.object({
    bytesCompleted: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    wanted: z.boolean(),
    priority: z.number().int().min(-1).max(1)
  })).max(100_000)
}).refine(({ files, fileStats }) => files.length === fileStats.length)

export interface TransmissionFile {
  index: number
  name: string
  size: number
  downloaded: number
  wanted: boolean
  priority: number
}

export function parseTransmissionFiles(value: unknown): TransmissionFile[] {
  const response = z.object({ torrents: z.array(torrentFilesSchema).length(1) }).safeParse(value)
  if (!response.success) {
    throw new EngineError({
      code: 'INTERNAL',
      message: 'Transmission returned malformed torrent file data',
      retryable: false,
      cause: response.error
    })
  }
  const torrent = response.data.torrents[0]
  if (!torrent) {
    throw new EngineError({
      code: 'INTERNAL',
      message: 'Transmission returned no torrent file data',
      retryable: false
    })
  }
  return torrent.files.map((file, index) => {
    const stats = torrent.fileStats[index]
    if (!stats) {
      throw new EngineError({
        code: 'INTERNAL',
        message: 'Transmission returned incomplete torrent file data',
        retryable: false
      })
    }
    return {
      index,
      name: file.name,
      size: file.length,
      downloaded: stats.bytesCompleted,
      wanted: stats.wanted,
      priority: stats.priority
    }
  })
}

export function parseTransmissionTorrents(value: unknown): TransmissionTorrent[] {
  const response = z.object({ torrents: z.array(torrentSchema) }).safeParse(value)
  if (!response.success) {
    throw new EngineError({
      code: 'INTERNAL',
      message: 'Transmission returned malformed torrent status data',
      retryable: false,
      cause: response.error
    })
  }
  return response.data.torrents
}

export function parseTransmissionAddedTorrent(value: unknown): {
  id: number
  hashString: string
} {
  const response = z.object({
    'torrent-added': addedTorrentSchema.optional(),
    'torrent-duplicate': addedTorrentSchema.optional()
  }).safeParse(value)
  const torrent = response.success
    ? response.data['torrent-added'] ?? response.data['torrent-duplicate']
    : undefined
  if (!torrent) {
    throw new EngineError({
      code: 'INTERNAL',
      message: 'Transmission did not return a valid torrent identifier',
      retryable: false,
      cause: response.success ? undefined : response.error
    })
  }
  return torrent
}

export class TransmissionRpcClient implements TransmissionRpc {
  private sessionId: string | null = null

  constructor(private readonly credentials: SessionCredentials) {}

  async call(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const payload = JSON.stringify({ method, arguments: args })
    let retriedHandshake = false

    for (;;) {
      let response: Response
      try {
        response = await fetch(`http://127.0.0.1:${this.credentials.port}/transmission/rpc`, {
          method: 'POST',
          headers: {
            authorization: `Basic ${Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString('base64')}`,
            'content-type': 'application/json',
            ...(this.sessionId ? { 'x-transmission-session-id': this.sessionId } : {})
          },
          body: payload,
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS)
        })
      } catch (error) {
        throw new EngineError({
          code: 'TIMEOUT',
          message: 'Could not reach the local Transmission RPC service',
          retryable: true,
          cause: error
        })
      }

      if (response.status === 409 && !retriedHandshake) {
        const nextSessionId = response.headers.get('x-transmission-session-id')
        if (!nextSessionId || nextSessionId.length > 512) {
          throw new EngineError({
            code: 'INTERNAL',
            message: 'Transmission RPC rejected the request without a session ID',
            retryable: false
          })
        }
        this.sessionId = nextSessionId
        retriedHandshake = true
        continue
      }
      if (!response.ok) {
        throw new EngineError({
          code: 'INTERNAL',
          message: `Transmission RPC returned HTTP ${response.status}`,
          retryable: response.status >= 500
        })
      }

      let envelope: unknown
      try {
        envelope = await response.json()
      } catch (error) {
        throw new EngineError({
          code: 'INTERNAL',
          message: 'Transmission RPC returned invalid JSON',
          retryable: false,
          cause: error
        })
      }
      if (
        typeof envelope !== 'object' ||
        envelope === null ||
        !('result' in envelope) ||
        typeof envelope.result !== 'string' ||
        !('arguments' in envelope)
      ) {
        throw new EngineError({
          code: 'INTERNAL',
          message: 'Transmission RPC returned an invalid response shape',
          retryable: false
        })
      }
      if (envelope.result !== 'success') {
        const result = envelope.result.replace(/[\r\n\t]/g, ' ').slice(0, 200)
        throw new EngineError({
          code: 'INTERNAL',
          message: `Transmission RPC ${method} failed: ${result || 'unknown error'}`,
          retryable: false
        })
      }
      return envelope.arguments
    }
  }
}

export interface TransmissionManagerOptions {
  executablePath: string
  configDirectory: string
  downloadDirectory: string
}

export class TransmissionManager implements TransmissionClientProvider {
  private process: ChildProcess | null = null
  private client: TransmissionRpcClient | null = null
  private credentials: SessionCredentials | null = null
  private starting: Promise<TransmissionRpcClient> | null = null

  constructor(private readonly options: TransmissionManagerOptions) {}

  async start(): Promise<TransmissionRpcClient> {
    if (this.starting) return this.starting
    if (this.client) return this.client
    this.starting = this.startManaged()
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  private async startManaged(): Promise<TransmissionRpcClient> {
    const configuredExecutable = this.options.executablePath.trim()
    if (!configuredExecutable) {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'The bundled Transmission engine is not available for this platform',
        retryable: false
      })
    }
    const executablePath = /[\\/]/.test(configuredExecutable)
      ? resolve(configuredExecutable)
      : configuredExecutable
    if (/[\\/]/.test(configuredExecutable)) {
      try {
        await access(executablePath)
      } catch (error) {
        throw new EngineError({
          code: 'PRECONDITION_FAILED',
          message: 'The bundled Transmission engine is missing; run npm run prepare:transmission and rebuild the app',
          retryable: false,
          cause: error
        })
      }
    }
    const configDirectory = resolve(this.options.configDirectory)
    const downloadDirectory = resolve(this.options.downloadDirectory)
    await mkdir(configDirectory, { recursive: true })
    await mkdir(downloadDirectory, { recursive: true })
    this.credentials = await loadOrCreateCredentials(configDirectory, downloadDirectory)
    this.client = new TransmissionRpcClient(this.credentials)

    if (await this.isResponsive()) return this.client

    log.info('Starting managed Transmission daemon', { executablePath })
    const child = spawn(executablePath, ['--foreground', '--config-dir', configDirectory], {
      stdio: 'ignore',
      windowsHide: true
    })
    this.process = child
    let spawnError: Error | null = null
    child.once('error', (error) => {
      spawnError = error
      log.error('Transmission process failed to start', { code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' })
    })
    child.once('exit', (code, signal) => {
      if (this.process === child) {
        this.process = null
        this.client = null
        log.warn('Transmission daemon exited', { code, signal })
      }
    })

    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (spawnError) {
        this.process = null
        this.client = null
        throw new EngineError({
          code: 'PRECONDITION_FAILED',
          message: 'Could not start Transmission; check the executable path in Settings',
          retryable: false,
          cause: spawnError
        })
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        this.process = null
        this.client = null
        throw new EngineError({
          code: 'INTERNAL',
          message: `Transmission exited during startup (code ${child.exitCode ?? child.signalCode ?? 'unknown'})`,
          retryable: false
        })
      }
      if (await this.isResponsive()) return this.client
      await delay(START_POLL_MS)
    }

    await this.stopOwnedProcess()
    throw new EngineError({
      code: 'TIMEOUT',
      message: 'Transmission did not start its authenticated local RPC service in time',
      retryable: true
    })
  }

  async shutdown(): Promise<void> {
    this.client = null
    await this.stopOwnedProcess()
  }

  private async isResponsive(): Promise<boolean> {
    try {
      await this.client?.call('session-get')
      return this.client !== null
    } catch {
      return false
    }
  }

  private async stopOwnedProcess(): Promise<void> {
    const child = this.process
    this.process = null
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        child.kill()
        rejectPromise(new Error('Transmission did not stop after termination'))
      }, 5000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolvePromise()
      })
      child.kill()
    })
  }
}

async function loadOrCreateCredentials(
  configDirectory: string,
  downloadDirectory: string
): Promise<SessionCredentials> {
  const credentialsPath = join(configDirectory, 'moth-rpc.json')
  try {
    const parsed: unknown = JSON.parse(await readFile(credentialsPath, 'utf8'))
    const credentials = credentialsSchema.safeParse(parsed)
    if (credentials.success) {
      await writeTransmissionSettings(configDirectory, downloadDirectory, credentials.data)
      return credentials.data
    }
    throw new Error('Stored Transmission credentials are malformed')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new EngineError({
        code: 'INTERNAL',
        message: 'Could not read Moth’s saved Transmission configuration',
        retryable: false,
        cause: error
      })
    }
  }

  const credentials: SessionCredentials = {
    port: randomInt(42000, 60000),
    username: 'moth',
    password: randomBytes(32).toString('hex')
  }
  await writeFile(credentialsPath, JSON.stringify(credentials), { mode: 0o600, flag: 'wx' })
  await chmod(credentialsPath, 0o600).catch((error: unknown) => {
    log.warn('Could not restrict Transmission credential file permissions', {
      code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'
    })
  })
  await writeTransmissionSettings(configDirectory, downloadDirectory, credentials)
  return credentials
}

async function writeTransmissionSettings(
  configDirectory: string,
  downloadDirectory: string,
  credentials: SessionCredentials
): Promise<void> {
  const settings = {
    'download-dir': downloadDirectory,
    'rpc-authentication-required': true,
    'rpc-bind-address': '127.0.0.1',
    'rpc-enabled': true,
    'rpc-password': credentials.password,
    'rpc-port': credentials.port,
    'rpc-url': '/transmission/',
    'rpc-username': credentials.username,
    'rpc-whitelist': '127.0.0.1',
    'rpc-whitelist-enabled': true,
    'start-added-torrents': false
    // Deliberately no seed-ratio keys here. `seed-ratio-limited`,
    // `seed_ratio_limited` and `seedRatioLimited` were each measured against
    // Transmission 4.1.3 and all three are ignored when read from
    // settings.json - the daemon reports its own defaults either way. Seeding
    // stops because `torrent/task.ts` issues `torrent-stop` once a torrent
    // finishes, not because of a setting. Do not add them back.
  }
  await writeFile(join(configDirectory, 'settings.json'), JSON.stringify(settings, null, 2), {
    mode: 0o600
  })
}

const delay = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
