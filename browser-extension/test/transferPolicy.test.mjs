import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const policyPaths = [
  new URL('../chrome/transferPolicy.js', import.meta.url),
  new URL('../firefox/transferPolicy.js', import.meta.url)
]

async function loadPolicy(path) {
  const source = await readFile(path, 'utf8')
  const context = { URL }
  runInNewContext(source, context)
  return context.MothTransferPolicy
}

for (const path of policyPaths) {
  describe(`handoff policy (${path.pathname.includes('/chrome/') ? 'Chrome' : 'Firefox'})`, () => {
    it('applies excluded sites to referring-page and direct-link sends', async () => {
      const policy = await loadPolicy(path)
      const preferences = { blacklist: '.example.com' }
      assert.equal(
        policy.transferDecision(
          { url: 'https://cdn.test/file.zip', referer: 'https://watch.example.com/' },
          preferences
        ).allowed,
        false
      )
      assert.equal(
        policy.transferDecision({ url: 'https://example.com/file.zip' }, preferences).allowed,
        false
      )
      assert.equal(
        policy.transferDecision({ url: 'https://notexample.com/file.zip' }, preferences).allowed,
        true
      )
    })

    it('applies excluded file types without treating query strings as extensions', async () => {
      const policy = await loadPolicy(path)
      const preferences = { excludedTypes: '.exe, msi zip' }
      assert.equal(policy.isExtensionExcluded('https://cdn.test/app.EXE?mirror=1', preferences.excludedTypes), true)
      assert.equal(policy.isExtensionExcluded('https://cdn.test/download?file=app.exe', preferences.excludedTypes), false)
      const decision = policy.transferDecision(
        { url: 'https://cdn.test/app.msi', referer: 'https://safe.test/' },
        preferences
      )
      assert.equal(decision.allowed, false)
      assert.equal(decision.reason, 'The .msi file type is excluded.')
    })

    it('only names a download when the URL actually names a file', async () => {
      const policy = await loadPolicy(path)
      // A download button that redirects to an installer names nothing itself.
      assert.equal(policy.filenameForUrl('https://host.test/download/pc/'), undefined)
      assert.equal(policy.filenameForUrl('https://host.test/download/pc'), undefined)
      assert.equal(policy.filenameForUrl('https://host.test/'), undefined)
      assert.equal(policy.filenameForUrl('not a url'), undefined)
      // A URL that names a file keeps that name.
      assert.equal(policy.filenameForUrl('https://host.test/files/app.exe'), 'app.exe')
      assert.equal(policy.filenameForUrl('https://host.test/files/app.exe?token=1'), 'app.exe')
      assert.equal(policy.filenameForUrl('https://host.test/files/archive.tar.gz'), 'archive.tar.gz')
    })

    it('rejects a browser-supplied name that carries no extension', async () => {
      const policy = await loadPolicy(path)
      assert.equal(policy.isUsableFilename('clip.mp4'), true)
      assert.equal(policy.isUsableFilename('setup.exe'), true)
      assert.equal(policy.isUsableFilename('pc'), false)
      assert.equal(policy.isUsableFilename(undefined), false)
      assert.equal(policy.isUsableFilename(''), false)
    })

    it('never cancels browser downloads before accepted handoff, and keeps exclusions in-browser', async () => {
      const policy = await loadPolicy(path)
      const order = []
      const item = { id: 17, url: 'https://files.test/archive.zip', referrer: 'https://safe.test/' }
      const accepted = await policy.handoffAutomaticDownload(
        item,
        { autoIntercept: true },
        { url: item.url, referer: item.referrer },
        async () => { order.push('accepted') },
        async () => { order.push('cancelled') }
      )
      assert.equal(accepted.cancelled, true)
      assert.deepEqual(order, ['accepted', 'cancelled'])

      order.length = 0
      await assert.rejects(
        policy.handoffAutomaticDownload(
          item,
          { autoIntercept: true },
          { url: item.url, referer: item.referrer },
          async () => { order.push('failed'); throw new Error('app offline') },
          async () => { order.push('cancelled') }
        ),
        /app offline/
      )
      assert.deepEqual(order, ['failed'])

      const excluded = await policy.handoffAutomaticDownload(
        item,
        { autoIntercept: true, excludedTypes: 'zip' },
        { url: item.url, referer: item.referrer },
        async () => { order.push('should not send') },
        async () => { order.push('should not cancel') }
      )
      assert.equal(excluded.cancelled, false)
      assert.match(excluded.reason, /excluded/)
      assert.deepEqual(order, ['failed'])
    })
  })
}
