#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PROTOCOL_VERSION = '2025-03-26'
const MAX_MESSAGE_BYTES = 1024 * 1024
const API_TIMEOUT_MS = 15_000
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled', 'cancelled'])

const tools = [
  {
    name: 'moth_status',
    description: 'Get Moth health and aggregate download statistics.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'moth_list_downloads',
    description: 'List Moth downloads and their current status, progress, and safe source URL.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'moth_get_download',
    description: 'Get the current status and progress for one Moth download.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1, maxLength: 128 } },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'moth_add_download',
    description: 'Add an HTTP(S) file URL, remote .torrent URL, or BitTorrent magnet to Moth. Set format to request media-page resolution.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 1, maxLength: 4096 },
        filename: { type: 'string', minLength: 1, maxLength: 240 },
        format: { type: 'string', enum: ['video', 'audio'] },
        videoQuality: { type: 'integer', enum: [360, 480, 720, 1080, 1440, 2160] },
        audioFormat: { type: 'string', enum: ['source', 'mp3'] }
      },
      required: ['url'],
      additionalProperties: false
    }
  },
  ...['pause', 'resume', 'retry', 'cancel'].map((action) => ({
    name: `moth_${action}_download`,
    description: `${action[0]?.toUpperCase()}${action.slice(1)} one Moth download.`,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1, maxLength: 128 } },
      required: ['id'],
      additionalProperties: false
    }
  })),
  {
    name: 'moth_wait_for_download',
    description: 'Wait for a Moth download to complete or fail, for up to 120 seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 128 },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 120, default: 30 }
      },
      required: ['id'],
      additionalProperties: false
    }
  }
]

function setting(dbPath, key) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null
  } finally {
    db.close()
  }
}

function defaultProfileDirectory() {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'moth-dlm')
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'moth-dlm')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'moth-dlm')
}

function connection() {
  const apiUrl = process.env.MOTH_API_URL
  const apiToken = process.env.MOTH_API_TOKEN
  if (apiUrl || apiToken) {
    if (!apiUrl || !apiToken) throw new Error('Set both MOTH_API_URL and MOTH_API_TOKEN')
    let parsed
    try {
      parsed = new URL(apiUrl)
    } catch {
      throw new Error('MOTH_API_URL must be a valid loopback URL')
    }
    const port = Number(parsed.port)
    if (
      parsed.protocol !== 'http:' ||
      parsed.hostname !== '127.0.0.1' ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error('MOTH_API_URL must be http://127.0.0.1:<port>')
    }
    if (!/^[a-f\d]{64}$/i.test(apiToken)) throw new Error('MOTH_API_TOKEN must be a 64-character pairing token')
    return { port, token: apiToken }
  }

  const profileDirectory = process.env.MOTH_PROFILE_DIR || defaultProfileDirectory()
  const dbPath = join(profileDirectory, 'moth.db')
  if (!existsSync(dbPath)) throw new Error(`No Moth database at ${dbPath}; is Moth running?`)
  const token = setting(dbPath, 'ingestToken')
  const port = Number(setting(dbPath, 'ingestPort'))
  if (typeof token !== 'string' || !/^[a-f\d]{64}$/i.test(token) ||
      !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Moth has no valid local API pairing in ${profileDirectory}`)
  }
  return { port, token }
}

async function callMoth(connectionInfo, path, options = {}) {
  let response
  try {
    response = await fetch(`http://127.0.0.1:${connectionInfo.port}${path}`, {
      ...options,
      headers: {
        ...(options.headers || {}),
        'x-moth-token': connectionInfo.token
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    })
  } catch (error) {
    throw new Error('Could not reach Moth on its authenticated local API', { cause: error })
  }
  const body = await response.json().catch(() => null)
  if (!response.ok || body?.ok === false) {
    const message = typeof body?.error?.message === 'string'
      ? body.error.message
      : `Moth API returned HTTP ${response.status}`
    throw new Error(message)
  }
  return body
}

function assertArguments(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Tool arguments must be a JSON object')
  }
  return value
}

function assertKeys(args, allowed) {
  const invalid = Object.keys(args).find((key) => !allowed.includes(key))
  if (invalid) throw new Error(`Unknown tool argument: ${invalid}`)
}

function assertId(args) {
  assertKeys(args, ['id'])
  if (typeof args.id !== 'string' || args.id.length < 1 || args.id.length > 128) {
    throw new Error('id must be a non-empty string of at most 128 characters')
  }
  return encodeURIComponent(args.id)
}

function validateAdd(args) {
  assertKeys(args, ['url', 'filename', 'format', 'videoQuality', 'audioFormat'])
  if (typeof args.url !== 'string' || args.url.length < 1 || args.url.length > 4096) {
    throw new Error('url must be a non-empty string of at most 4096 characters')
  }
  let url
  try {
    url = new URL(args.url)
  } catch {
    throw new Error('url must be an HTTP(S) URL or supported BitTorrent magnet')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'magnet:') {
    throw new Error('Moth only accepts HTTP(S) URLs and supported BitTorrent magnets')
  }
  if (url.protocol === 'magnet:' && !url.searchParams.getAll('xt').some((topic) =>
    /^urn:btih:(?:[a-f\d]{40}|[a-z2-7]{32})$/i.test(topic) ||
    /^urn:btmh:(?:1220[a-f\d]{64}|b[a-z2-7]{52,56})$/i.test(topic)
  )) {
    throw new Error('Magnet URL must include a supported BitTorrent v1 or v2 topic')
  }
  if (args.filename !== undefined &&
      (typeof args.filename !== 'string' || args.filename.length < 1 || args.filename.length > 240)) {
    throw new Error('filename must contain 1 to 240 characters')
  }
  if (args.format !== undefined && args.format !== 'video' && args.format !== 'audio') {
    throw new Error('format must be video or audio')
  }
  if (args.videoQuality !== undefined &&
      ![360, 480, 720, 1080, 1440, 2160].includes(args.videoQuality)) {
    throw new Error('videoQuality must be a supported quality')
  }
  if (args.audioFormat !== undefined && args.audioFormat !== 'source' && args.audioFormat !== 'mp3') {
    throw new Error('audioFormat must be source or mp3')
  }
  const isTorrent = url.protocol === 'magnet:' ||
    (url.protocol !== 'magnet:' && url.pathname.toLowerCase().endsWith('.torrent'))
  if (isTorrent &&
      (args.format !== undefined || args.videoQuality !== undefined || args.audioFormat !== undefined)) {
    throw new Error('Media format options do not apply to torrent sources')
  }
  if (args.format === undefined &&
      (args.videoQuality !== undefined || args.audioFormat !== undefined)) {
    throw new Error('format is required when setting videoQuality or audioFormat')
  }
  return {
    url: args.url,
    ...(args.filename !== undefined ? { filename: args.filename } : {}),
    ...(args.format !== undefined ? { format: args.format } : {}),
    ...(args.videoQuality !== undefined ? { videoQuality: args.videoQuality } : {}),
    ...(args.audioFormat !== undefined ? { audioFormat: args.audioFormat } : {})
  }
}

async function callTool(name, rawArgs, connectionInfo) {
  const args = assertArguments(rawArgs ?? {})
  if (name === 'moth_status') {
    assertKeys(args, [])
    return (await callMoth(connectionInfo, '/api/v1/status')).data
  }
  if (name === 'moth_list_downloads') {
    assertKeys(args, [])
    return (await callMoth(connectionInfo, '/api/v1/downloads')).data
  }
  if (name === 'moth_get_download') {
    const id = assertId(args)
    return (await callMoth(connectionInfo, `/api/v1/downloads/${id}`)).data
  }
  if (name === 'moth_add_download') {
    const input = validateAdd(args)
    return (await callMoth(connectionInfo, '/api/v1/downloads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input)
    })).data
  }
  if (['pause', 'resume', 'retry', 'cancel'].some((action) => name === `moth_${action}_download`)) {
    const action = name.slice('moth_'.length, -'_download'.length)
    const id = assertId(args)
    return (await callMoth(connectionInfo, `/api/v1/downloads/${id}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })).data
  }
  if (name === 'moth_wait_for_download') {
    assertKeys(args, ['id', 'timeoutSeconds'])
    const id = assertId(args)
    const timeoutSeconds = args.timeoutSeconds ?? 30
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) {
      throw new Error('timeoutSeconds must be an integer from 1 to 120')
    }
    const deadline = Date.now() + timeoutSeconds * 1000
    for (;;) {
      const download = (await callMoth(connectionInfo, `/api/v1/downloads/${id}`)).data
      if (TERMINAL_STATUSES.has(download.status)) return download
      if (Date.now() >= deadline) return download
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())))
    }
  }
  throw new Error(`Unknown Moth tool: ${name}`)
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function handleMessage(message) {
  if (typeof message !== 'object' || message === null || Array.isArray(message) ||
      message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    if (message && typeof message === 'object' && 'id' in message) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Invalid Request' } })
    }
    return
  }
  const hasId = Object.hasOwn(message, 'id')
  if (!hasId) return

  try {
    if (message.method === 'initialize') {
      const requestedVersion = message.params?.protocolVersion
      const supportedVersions = [PROTOCOL_VERSION, '2025-06-18', '2025-11-25']
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: supportedVersions.includes(requestedVersion)
            ? requestedVersion
            : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'moth-download-manager', version: '1.0.0' }
        }
      })
      return
    }
    if (message.method === 'ping') {
      send({ jsonrpc: '2.0', id: message.id, result: {} })
      return
    }
    if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools } })
      return
    }
    if (message.method === 'tools/call') {
      const params = message.params
      if (typeof params !== 'object' || params === null || Array.isArray(params) ||
          typeof params.name !== 'string') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{ type: 'text', text: 'tools/call requires a tool name' }],
            isError: true
          }
        })
        return
      }
      try {
        const connectionInfo = connection()
        const result = await callTool(params.name, params.arguments, connectionInfo)
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: JSON.stringify(result) }] }
        })
      } catch (error) {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
            isError: true
          }
        })
      }
      return
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` }
    })
  } catch (error) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error)
      }
    })
  }
}

function start() {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    input += chunk
    if (Buffer.byteLength(input) > MAX_MESSAGE_BYTES && !input.includes('\n')) {
      process.stderr.write('Moth MCP: input message exceeds 1 MiB\n')
      process.exitCode = 1
      process.stdin.destroy()
      return
    }
    for (;;) {
      const newline = input.indexOf('\n')
      if (newline < 0) break
      const line = input.slice(0, newline)
      input = input.slice(newline + 1)
      if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: message too large' } })
        continue
      }
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
        continue
      }
      void handleMessage(message)
    }
    if (Buffer.byteLength(input) > MAX_MESSAGE_BYTES) {
      process.stderr.write('Moth MCP: input message exceeds 1 MiB\n')
      process.exitCode = 1
      process.stdin.destroy()
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start()
