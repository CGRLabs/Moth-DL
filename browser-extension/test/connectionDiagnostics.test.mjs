import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const helperPaths = [
  new URL('../chrome/connectionDiagnostics.js', import.meta.url),
  new URL('../firefox/connectionDiagnostics.js', import.meta.url)
]

async function loadHelper(path) {
  const source = await readFile(path, 'utf8')
  const context = { AbortController, URL, clearTimeout, setTimeout }
  runInNewContext(source, context)
  return context.MothConnectionDiagnostics.diagnoseConnection
}

for (const path of helperPaths) {
  describe(`connection diagnostics (${path.pathname.includes('/chrome/') ? 'Chrome' : 'Firefox'})`, () => {
    it('identifies a valid pairing', async () => {
      const diagnose = await loadHelper(path)
      const result = await diagnose({ port: 24678, token: 'secret' }, async () => ({
        status: 200,
        json: async () => ({ app: 'moth-dlm' })
      }))
      assert.equal(result.status, 'connected')
    })

    it('distinguishes a rejected token from an unreachable app', async () => {
      const diagnose = await loadHelper(path)
      const result = await diagnose({ port: 24678, token: 'stale' }, async () => ({
        status: 401,
        json: async () => ({ ok: false, error: 'Invalid or missing X-Moth-Token' })
      }))
      assert.equal(result.status, 'invalid-token')
    })

    it('finds Moth when it is listening on a different default port', async () => {
      const diagnose = await loadHelper(path)
      const result = await diagnose({ port: 24678, token: 'secret' }, async (url) => {
        const port = Number(new URL(url).port)
        if (port === 24678) throw new Error('connection refused')
        return port === 24679
          ? { status: 401, json: async () => ({ ok: false, error: 'Invalid or missing X-Moth-Token' }) }
          : { status: 0 }
      })
      assert.equal(result.status, 'wrong-port')
      assert.equal(result.foundPort, 24679)
    })

    it('reports when Moth cannot be reached and validates port and token input', async () => {
      const diagnose = await loadHelper(path)
      const noResponse = async () => {
        throw new Error('connection refused')
      }
      const unavailable = await diagnose({ port: 24678, token: 'secret' }, noResponse)
      assert.equal(unavailable.status, 'unavailable')
      assert.equal((await diagnose({ port: 70000, token: 'secret' }, noResponse)).status, 'invalid-port')
      assert.equal((await diagnose({ port: 24678, token: '' }, noResponse)).status, 'missing-token')
      const wrongService = await diagnose({ port: 24678, token: 'secret' }, async () => ({
        status: 200,
        json: async () => ({ app: 'other' })
      }))
      assert.equal(wrongService.status, 'wrong-service')
      const unrelatedUnauthorizedService = await diagnose(
        { port: 24678, token: 'secret' },
        async () => ({ status: 401, json: async () => ({ error: 'Unauthorized' }) })
      )
      assert.equal(unrelatedUnauthorizedService.status, 'wrong-service')
    })
  })
}
