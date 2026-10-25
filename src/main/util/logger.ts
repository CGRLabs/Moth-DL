/**
 * Structured logging with size-based rotation.
 *
 * Design notes:
 *  - File output is newline-delimited JSON so logs can be tailed, shipped or
 *    queried without a parser, while the console gets colourised human text.
 *  - Writes are serialised through a promise chain rather than a raw stream:
 *    this keeps ordering guarantees, keeps rotation trivially correct, and
 *    lets us `await` a flush during shutdown.
 *  - A logging failure must never take the app down, so every sink error is
 *    swallowed after a single diagnostic to stderr.
 */

import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { LogLevel, LogLine } from '@shared/types.js'
import { LOG_FILE_NAME, LOG_MAX_BYTES, LOG_MAX_FILES } from '@shared/constants.js'

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4
}

const COLORS: Record<LogLevel, string> = {
  error: '[31m',
  warn: '[33m',
  info: '[36m',
  debug: '[35m',
  trace: '[90m'
}
const RESET = '[0m'
const SENSITIVE_KEY = /authorization|cookie|password|passwd|token|secret|api.?key|access.?key|refresh.?key|credential|signature|jwt|session/i
const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/gi
const MAX_LOG_STRING_LENGTH = 32_768
const MAX_LOG_DEPTH = 8
const MAX_LOG_ENTRIES = 100

/** A rendered log record, in both machine and human form. */
export interface RenderedLog {
  /** Newline-delimited JSON, for the rotating file. */
  json: string
  /** Colourised human text, for the console. */
  text: string
}

export interface LogSink {
  write(line: LogLine, rendered: RenderedLog): void | Promise<void>
  flush?(): Promise<void>
  close?(): Promise<void>
}

/** Collects lines in memory. Used by tests and by the in-app log viewer. */
export class MemorySink implements LogSink {
  readonly lines: LogLine[] = []
  constructor(private readonly limit = 2000) {}
  write(line: LogLine): void {
    this.lines.push(line)
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit)
  }
  flush(): Promise<void> {
    return Promise.resolve()
  }
  text(level?: LogLevel): string[] {
    return this.lines.filter((l) => !level || l.level === level).map((l) => l.message)
  }
}

/** Appends to a rotating file. */
export class RotatingFileSink implements LogSink {
  private queue: Promise<void> = Promise.resolve()
  private currentSize = 0
  private closed = false

  constructor(
    private readonly directory: string,
    private readonly fileName: string = LOG_FILE_NAME,
    private readonly maxBytes: number = LOG_MAX_BYTES,
    private readonly maxFiles: number = LOG_MAX_FILES
  ) {}

  private get path(): string {
    return join(this.directory, this.fileName)
  }

  /** Rotates `moth.log` -> `moth.1.log` -> ... dropping the oldest. */
  private async rotate(): Promise<void> {
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const from = join(this.directory, rotatedName(this.fileName, index))
      const to = join(this.directory, rotatedName(this.fileName, index + 1))
      if (existsSync(from)) {
        if (index + 1 > this.maxFiles) {
          await rm(from, { force: true })
        } else {
          await rename(from, to)
        }
      }
    }
    const oldest = join(this.directory, rotatedName(this.fileName, this.maxFiles))
    await rm(oldest, { force: true })
    await rename(this.path, join(this.directory, rotatedName(this.fileName, 1)))
    this.currentSize = 0
  }

  private async ensureSize(): Promise<void> {
    if (this.currentSize > 0) return
    try {
      const info = await stat(this.path)
      this.currentSize = info.size
    } catch {
      this.currentSize = 0
    }
  }

  write(_line: LogLine, rendered: RenderedLog): void {
    if (this.closed) return
    const text = rendered.json
    this.queue = this.queue
      .then(async () => {
        await this.ensureSize()
        if (this.currentSize + text.length > this.maxBytes && this.currentSize > 0) {
          await this.rotate()
        }
        await appendFile(this.path, text, 'utf8')
        this.currentSize += text.length
      })
      .catch((err: unknown) => {
        process.stderr.write(`[moth:logger] sink write failed: ${String(err)}\n`)
      })
  }

  async flush(): Promise<void> {
    await this.queue
  }

  async close(): Promise<void> {
    await this.flush()
    this.closed = true
  }
}

function rotatedName(fileName: string, index: number): string {
  const dot = fileName.lastIndexOf('.')
  if (dot === -1) return `${fileName}.${index}`
  return `${fileName.slice(0, dot)}.${index}${fileName.slice(dot)}`
}

/** Colourised stdout/stderr writer. */
class ConsoleSink implements LogSink {
  constructor(private readonly getMinWeight: () => number) {}
  write(line: LogLine, rendered: RenderedLog): void {
    if (LEVEL_WEIGHT[line.level] > this.getMinWeight()) return
    const stream = line.level === 'error' || line.level === 'warn' ? process.stderr : process.stdout
    const text = rendered.text
    stream.write(text.endsWith('\n') ? text : text + '\n')
  }
}

export interface LoggerConfig {
  level: LogLevel
  directory: string | null
  /** Mirrors file records to an external consumer (e.g. the renderer log panel). */
  observer?: (line: LogLine) => void
  /** Force-disable colours (tests, or when stdout is not a TTY). */
  color?: boolean
}

/** A named logger. Cheap to create; all instances share one sink set. */
export class Logger {
  constructor(
    private readonly scope: string,
    private readonly getConfig: () => LoggerConfig,
    private readonly sinks: LogSink[]
  ) {}

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`, this.getConfig, this.sinks)
  }

  private emit(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    const config = this.getConfig()
    if (LEVEL_WEIGHT[level] > LEVEL_WEIGHT[config.level]) return

    const line: LogLine = {
      timestamp: Date.now(),
      level,
      scope: this.scope,
      message: sanitizeLogText(message),
      ...(data ? { data: sanitizeLogData(data) } : {})
    }

    const json = JSON.stringify(line)
    const time = new Date(line.timestamp).toISOString()
    const colour = config.color === false ? '' : (COLORS[level] ?? '')
    const reset = colour ? RESET : ''
    const suffix = line.data ? ` ${JSON.stringify(line.data)}` : ''
    const text = `${colour}${time} ${level.toUpperCase().padEnd(5)} [${line.scope}]${reset} ${message}${suffix}`
    const rendered: RenderedLog = { json: `${json}\n`, text }

    for (const sink of this.sinks) {
      try {
        sink.write(line, rendered)
      } catch (err) {
        process.stderr.write(`[moth:logger] sink threw: ${String(err)}\n`)
      }
    }
    try {
      config.observer?.(line)
    } catch {
      /* observer failures must not propagate */
    }
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.emit('error', message, data)
  }
  warn(message: string, data?: Record<string, unknown>): void {
    this.emit('warn', message, data)
  }
  info(message: string, data?: Record<string, unknown>): void {
    this.emit('info', message, data)
  }
  debug(message: string, data?: Record<string, unknown>): void {
    this.emit('debug', message, data)
  }
  trace(message: string, data?: Record<string, unknown>): void {
    this.emit('trace', message, data)
  }
}

let config: LoggerConfig = { level: 'info', directory: null }
let sinks: LogSink[] = []
let fileSink: RotatingFileSink | null = null
let rootLogger: Logger | null = null

/**
 * Boots the logging subsystem. Safe to call again; the previous file sink is
 * closed first so logs are never split across two handles.
 */
export async function initLogging(options: {
  level?: LogLevel
  directory?: string | null
  console?: boolean
  observer?: (line: LogLine) => void
  color?: boolean
}): Promise<Logger> {
  await fileSink?.close().catch(() => {})

  config = {
    level: options.level ?? config.level,
    directory: options.directory ?? null,
    observer: options.observer,
    color: options.color ?? process.stdout.isTTY === true
  }

  sinks = []
  if (options.console !== false) {
    sinks.push(new ConsoleSink(() => LEVEL_WEIGHT[config.level]))
  }
  fileSink = null
  if (config.directory) {
    await mkdir(config.directory, { recursive: true }).catch(() => {})
    fileSink = new RotatingFileSink(config.directory)
    sinks.push(fileSink)
  }

  rootLogger = new Logger('moth', () => config, sinks)
  return rootLogger
}

/** Returns a scoped logger. Works before `initLogging`, so tests need no setup. */
export function getLogger(scope: string): Logger {
  if (!rootLogger) {
    rootLogger = new Logger('moth', () => config, sinks.length > 0 ? sinks : [defaultConsoleSink()])
    if (sinks.length === 0) sinks = [defaultConsoleSink()]
  }
  return rootLogger.child(scope)
}

function defaultConsoleSink(): LogSink {
  return new ConsoleSink(() => LEVEL_WEIGHT[config.level])
}

/** Updates the active logging threshold without replacing existing sinks. */
export function setLogLevel(level: LogLevel): void {
  config = { ...config, level }
}

export async function flushLogs(): Promise<void> {
  for (const sink of sinks) {
    try {
      await sink.flush?.()
    } catch {
      /* ignore */
    }
  }
}

export async function shutdownLogging(): Promise<void> {
  await flushLogs()
  await fileSink?.close().catch(() => {})
  fileSink = null
  sinks = []
  rootLogger = null
}

/** Injects an extra sink (used by tests and the renderer's log panel). */
export function addSink(sink: LogSink): void {
  sinks.push(sink)
  if (rootLogger) rootLogger = new Logger('moth', () => config, sinks)
}

/** Redacts URL credentials/query values and common secret-bearing headers. */
export function sanitizeLogText(value: string): string {
  const sanitized = value
    .replace(URL_IN_TEXT, (raw) => {
      let suffix = ''
      let candidate = raw
      while (/[),.;\]}]$/.test(candidate)) {
        suffix = candidate.slice(-1) + suffix
        candidate = candidate.slice(0, -1)
      }
      try {
        const parsed = new URL(candidate)
        if (parsed.username) parsed.username = '[REDACTED]'
        if (parsed.password) parsed.password = '[REDACTED]'
        if (parsed.search) {
          const redacted = new URLSearchParams()
          for (const [key] of parsed.searchParams) {
            redacted.append(key, '[REDACTED]')
          }
          parsed.search = redacted.toString()
        }
        if (parsed.hash) parsed.hash = '#[REDACTED]'
        return parsed.href + suffix
      } catch {
        return '[REDACTED_URL]' + suffix
      }
    })
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(/\b(cookie|set-cookie|authorization|proxy-authorization)\s*:\s*[^\r\n]*/gi, '$1: [REDACTED]')

  return sanitized.length > MAX_LOG_STRING_LENGTH
    ? `${sanitized.slice(0, MAX_LOG_STRING_LENGTH)}...[truncated]`
    : sanitized
}

/** Sanitizes arbitrary diagnostic data before it reaches either log sink. */
export function sanitizeLogData(data: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>()

  const visit = (value: unknown, key: string, depth: number): unknown => {
    if (SENSITIVE_KEY.test(key)) return '[REDACTED]'
    if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
      return value
    }
    if (typeof value === 'string') return sanitizeLogText(value)
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'function' || typeof value === 'symbol') return String(value)
    if (depth >= MAX_LOG_DEPTH) return '[truncated: maximum diagnostic depth]'
    if (value instanceof URL) return sanitizeLogText(value.href)
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
    if (typeof value !== 'object') return String(value)
    if (seen.has(value)) return '[Circular]'
    seen.add(value)

    if (value instanceof Error) {
      const error: Record<string, unknown> = {
        name: sanitizeLogText(value.name),
        message: sanitizeLogText(value.message),
        ...(value.stack ? { stack: sanitizeLogText(value.stack) } : {})
      }
      for (const field of ['code', 'retryable', 'httpStatus', 'context', 'cause'] as const) {
        if (field in value) {
          error[field] = visit((value as Error & Record<string, unknown>)[field], field, depth + 1)
        }
      }
      return error
    }
    if (Array.isArray(value)) {
      return [
        ...value.slice(0, MAX_LOG_ENTRIES).map((entry) => visit(entry, key, depth + 1)),
        ...(value.length > MAX_LOG_ENTRIES ? ['[truncated]'] : [])
      ]
    }

    const entries = Object.entries(value).slice(0, MAX_LOG_ENTRIES)
    const output: Record<string, unknown> = {}
    for (const [childKey, childValue] of entries) {
      output[childKey] = visit(childValue, childKey, depth + 1)
    }
    if (Object.keys(value).length > MAX_LOG_ENTRIES) output['[truncated]'] = true
    return output
  }

  return visit(data, '', 0) as Record<string, unknown>
}
