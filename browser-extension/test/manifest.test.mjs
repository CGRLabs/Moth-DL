import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const manifests = [
  new URL('../chrome/manifest.json', import.meta.url),
  new URL('../firefox/manifest.json', import.meta.url)
]

for (const path of manifests) {
  describe(`manifest permissions (${path.pathname.includes('/chrome/') ? 'Chrome' : 'Firefox'})`, () => {
    it('limits app networking to loopback and does not request cookies or webRequest', async () => {
      const manifest = JSON.parse(await readFile(path, 'utf8'))
      assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*'])
      assert.equal(manifest.permissions.includes('cookies'), false)
      assert.equal(manifest.permissions.includes('webRequest'), false)
      assert.equal(manifest.version, '1.1.4')
    })

    it('loads the shared transfer policy before page badge scripts', async () => {
      const manifest = JSON.parse(await readFile(path, 'utf8'))
      const contentScripts = manifest.content_scripts[0].js
      assert.ok(contentScripts.indexOf('transferPolicy.js') >= 0)
      assert.ok(contentScripts.indexOf('transferPolicy.js') < contentScripts.indexOf('badgePrefs.js'))
    })

    it('declares content scripts that parse as classic browser scripts', async () => {
      const manifest = JSON.parse(await readFile(path, 'utf8'))
      for (const filename of manifest.content_scripts[0].js) {
        const source = await readFile(new URL(filename, path), 'utf8')
        assert.doesNotThrow(
          () => new vm.Script(source, { filename }),
          `${filename} must not contain module-only syntax`
        )
      }
    })

    it('keeps popup controls wired and popup scripts syntactically valid', async () => {
      const popupPath = new URL('./popup.html', path)
      const scriptPath = new URL('./popup.js', path)
      const markup = await readFile(popupPath, 'utf8')
      const source = await readFile(scriptPath, 'utf8')
      const ids = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]))
      const references = [...source.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1])

      for (const id of references) assert.ok(ids.has(id), `popup control #${id} must exist`)
      assert.doesNotThrow(() => new vm.Script(source, { filename: scriptPath.pathname }))
    })

    it('initializes page helpers in manifest order within one isolated world', async () => {
      const manifest = JSON.parse(await readFile(path, 'utf8'))
      const context = vm.createContext({})
      for (const filename of manifest.content_scripts[0].js) {
        const source = await readFile(new URL(filename, path), 'utf8')
        vm.runInContext(source, context, { filename })
      }
      assert.equal(typeof context.MothPageMeta.extractPageMetadata, 'function')
      assert.equal(typeof context.MothMediaProbe.discoverPageMedia, 'function')
      assert.equal(typeof context.MothTransferPolicy.transferDecision, 'function')
      assert.equal(typeof context.MothBadge.createBadge, 'function')
    })
  })
}
