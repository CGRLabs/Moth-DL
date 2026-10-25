import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadBackgroundHarness } from './loadBackgroundHarness.mjs'

for (const browser of ['chrome', 'firefox']) {
  describe(`background download handoff (${browser})`, () => {
    it('cancels only after the app accepts the download', async () => {
      const harness = loadBackgroundHarness(browser, {
        config: { autoIntercept: true, port: 24678, token: 'test-token' }
      })
      await harness.createDownload({
        id: 12,
        url: 'https://files.example/clip.mp4',
        filename: 'C:\\Downloads\\clip.mp4',
        referrer: 'https://files.example/watch'
      })

      assert.deepEqual(harness.calls.map((call) => call.type), ['fetch', 'cancel'])
      assert.equal(harness.calls[1].id, 12)
      assert.ok(harness.calls[0].args[0].endsWith('/ingest'))
    })

    it('keeps excluded files in the browser without sending them', async () => {
      const harness = loadBackgroundHarness(browser, {
        config: { autoIntercept: true, excludedTypes: 'mp4' }
      })
      await harness.createDownload({
        id: 13,
        url: 'https://files.example/clip.mp4',
        filename: 'clip.mp4'
      })

      assert.deepEqual(harness.calls, [])
    })

    it('leaves the browser download running when the app rejects the handoff', async () => {
      const harness = loadBackgroundHarness(browser, {
        config: { autoIntercept: true, port: 24678, token: 'test-token' },
        fetcher: async () => ({ ok: false, status: 503, async json() { return { error: 'unavailable' } } })
      })
      await harness.createDownload({
        id: 14,
        url: 'https://files.example/clip.mp4',
        filename: 'clip.mp4'
      })

      assert.deepEqual(harness.calls.map((call) => call.type), ['fetch'])
    })

    it('sends an extension-less download link without a guessed filename', async () => {
      const harness = loadBackgroundHarness(browser, {
        config: { autoIntercept: true, port: 24678, token: 'test-token' }
      })
      // A download button whose URL redirects to the real installer: neither the
      // browser's name ("pc") nor the URL names a file, so Moth must be left to
      // read the name from the response.
      await harness.createDownload({
        id: 15,
        url: 'https://files.example/download/pc/',
        filename: 'pc'
      })

      const body = JSON.parse(harness.calls[0]?.args[1]?.body ?? '{}')
      assert.equal(body.url, 'https://files.example/download/pc/')
      assert.equal(body.filename, undefined)
      assert.deepEqual(harness.calls.map((call) => call.type), ['fetch', 'cancel'])
    })

    it('keeps a real filename when the URL names a file', async () => {
      const harness = loadBackgroundHarness(browser, {
        config: { autoIntercept: true, port: 24678, token: 'test-token' }
      })
      await harness.createDownload({
        id: 16,
        url: 'https://files.example/download/pc',
        filename: 'setup.exe'
      })

      const body = JSON.parse(harness.calls[0]?.args[1]?.body ?? '{}')
      assert.equal(body.filename, 'setup.exe')
    })

    it('cold-starts Moth for an explicit context-menu send without a saved pairing token', async () => {
      const harness = loadBackgroundHarness(browser, {
        config: { port: 24678, token: '' },
        fetcher: async () => { throw new Error('connection refused') }
      })
      await harness.clickContextMenu(
        { menuItemId: 'moth-download', linkUrl: 'https://files.example/clip.mp4' },
        { id: 7, url: 'https://files.example/page' }
      )

      assert.equal(harness.calls.at(-1)?.type, 'tab-update')
      assert.equal(
        harness.calls.at(-1)?.options.url,
        `moth://download?url=${encodeURIComponent('https://files.example/clip.mp4')}`
      )
    })
  })
}
