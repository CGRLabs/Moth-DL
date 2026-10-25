import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDirectory = dirname(fileURLToPath(import.meta.url))

export function loadBackgroundHarness(browser, { config = {}, fetcher } = {}) {
  const extensionDirectory = join(testDirectory, '..', browser)
  const listeners = new Map()
  const calls = []
  const addListener = (name) => ({
    addListener(listener) {
      listeners.set(name, listener)
    }
  })
  const chrome = {
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {}
    },
    alarms: {
      onAlarm: addListener('alarm'),
      create() {}
    },
    contextMenus: {
      onClicked: addListener('context-menu'),
      create() {}
    },
    downloads: {
      onCreated: addListener('download'),
      async cancel(id) {
        calls.push({ type: 'cancel', id })
      }
    },
    notifications: { create() {} },
    runtime: {
      onInstalled: addListener('installed'),
      onStartup: addListener('startup'),
      onMessage: addListener('message'),
      async sendMessage() {},
      getURL(path) {
        return `chrome-extension://test/${path}`
      }
    },
    storage: {
      local: {
        async get(defaults) {
          return { ...defaults, ...config }
        },
        async set() {}
      }
    },
    tabs: {
      async query() {
        return []
      },
      async update(id, options) {
        calls.push({ type: 'tab-update', id, options })
      },
      async sendMessage() {}
    }
  }
  const context = vm.createContext({
    AbortController,
    URL,
    chrome,
    console: { warn() {}, error() {}, log() {} },
    fetch: async (...args) => {
      calls.push({ type: 'fetch', args })
      if (fetcher) return fetcher(...args)
      return { ok: true, status: 200, async json() { return { ok: true } } }
    },
    importScripts(...filenames) {
      for (const filename of filenames) {
        const path = join(extensionDirectory, filename)
        vm.runInContext(readFileSync(path, 'utf8'), context, { filename: path })
      }
    }
  })

  if (browser === 'firefox') {
    for (const filename of ['connectionDiagnostics.js', 'transferPolicy.js']) {
      const path = join(extensionDirectory, filename)
      vm.runInContext(readFileSync(path, 'utf8'), context, { filename: path })
    }
  }
  const backgroundFilename = browser === 'chrome' ? 'service-worker.js' : 'background.js'
  const backgroundPath = join(extensionDirectory, backgroundFilename)
  vm.runInContext(readFileSync(backgroundPath, 'utf8'), context, { filename: backgroundPath })

  return {
    calls,
    async createDownload(item) {
      await listeners.get('download')(item)
    },
    async clickContextMenu(info, tab) {
      await listeners.get('context-menu')(info, tab)
    }
  }
}
