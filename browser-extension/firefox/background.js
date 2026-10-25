/**
 * Moth background service worker (MV3).
 *
 * Responsibilities:
 *  1. In AUTO mode, catch each new browser download, cancel it, and hand the
 *     URL to the running Moth app so the transfer is resumable and throttled.
 *  2. Provide a right-click "Download with Moth" action for one-off links.
 *  3. Keep the toolbar badge showing whether Moth is reachable.
 *
 * Design notes:
 *  - Cancelling a download the user wanted in-browser would be hostile, so AUTO
 *    is opt-in and defaults to off. One-off sends are always available.
 *  - The source URL and referring page are handed only to the local app. The
 *    extension does not read browser cookies.
 *  - `downloads.cancel` needs the id from `onCreated`, so the cancel is always
 *    paired with the id we just received; a cancel failure is logged, not fatal.
 */

const DEFAULTS = {
  port: 24678,
  token: '',
  autoIntercept: false,
  notify: true,
  blacklist: '',
  excludedTypes: ''
}
const PORT_SCAN_COUNT = 12
async function getConfig() {
  const stored = await chrome.storage.local.get(DEFAULTS)
  return { ...DEFAULTS, ...stored }
}

async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text })
    if (color) await chrome.action.setBadgeBackgroundColor({ color })
  } catch {
    /* the action may not exist yet during startup */
  }
}

/** Reports the likely cause when the extension cannot reach Moth. */
async function diagnose(config) {
  return globalThis.MothConnectionDiagnostics.diagnoseConnection(config)
}

/** Sends one URL to Moth. Resolves to true when accepted. */
async function sendToMOTH(config, payload) {
  const decision = globalThis.MothTransferPolicy.transferDecision(payload, config)
  if (!decision.allowed) {
    const error = new Error(decision.reason)
    error.code = 'POLICY_BLOCKED'
    throw error
  }
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-moth-token': config.token
      },
      body: JSON.stringify(payload)
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${response.status}`)
    }
    return data
  } catch (err) {
    await setBadge('!', '#e11d48')
    throw err
  }
}

function guessFilename(url) {
  return globalThis.MothTransferPolicy.filenameForUrl(url)
}

/** AUTO mode: take over a download the browser has just started. */
chrome.downloads.onCreated.addListener(async (item) => {
  const config = await getConfig()
  // The browser's own name is trusted only when it carries an extension:
  // Chromium derives "pc" from an extension-less URL, which is not a name.
  const browserName = item.filename ? item.filename.split(/[\\/]/).pop() : undefined
  const payload = {
    url: item.url,
    filename: globalThis.MothTransferPolicy.isUsableFilename(browserName)
      ? browserName
      : guessFilename(item.url),
    referer: item.referrer || undefined,
    autoStart: true
  }
  try {
    const result = await globalThis.MothTransferPolicy.handoffAutomaticDownload(
      item,
      config,
      payload,
      (acceptedPayload) => sendToMOTH(config, acceptedPayload),
      (downloadId) => chrome.downloads.cancel(downloadId)
    )
    if (result.cancelled) await setBadge('', '#22c55e')
  } catch (err) {
    console.warn('[Moth] auto-intercept failed, leaving the browser download alone:', err)
  }
})

/** Right-click a link: download it with Moth. */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'moth-download',
    title: 'Download with Moth',
    contexts: ['link', 'image', 'video', 'audio']
  })
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'moth-download') return
  const config = await getConfig()
  const mediaType = info.mediaType
  const pageUrl = info.frameUrl || info.pageUrl || tab?.url || ''
  const clickedUrl = mediaType ? (info.srcUrl || info.linkUrl || '') : (info.linkUrl || info.srcUrl || '')
  const isManifest = /\.(m3u8|mpd)(?:$|[?#])/i.test(clickedUrl)
  const directUrl = /^https?:/i.test(clickedUrl) && !isManifest ? clickedUrl : ''
  const format = mediaType === 'audio' ? 'audio' : mediaType === 'video' || isManifest ? 'video' : undefined
  const url = directUrl || (format && /^https?:/i.test(pageUrl) ? pageUrl : '')
  if (!url) return
  const decision = globalThis.MothTransferPolicy.transferDecision({ url, referer: pageUrl }, config)
  if (!decision.allowed) {
    if (config.notify) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon128.png',
        title: 'Not sent to Moth',
        message: decision.reason
      })
    }
    return
  }
  // The worker cannot read the DOM, so it asks the tab's content script for
  // page metadata. That keeps one implementation (pageMeta.js) for both the
  // badge and the menu path; a missing content script just sends bare.
  let media
  try {
    if (tab && tab.id != null) {
      const message = { type: 'moth-page-meta', url }
      const reply = Number.isInteger(info.frameId)
        ? await chrome.tabs.sendMessage(tab.id, message, { frameId: info.frameId })
        : await chrome.tabs.sendMessage(tab.id, message)
      if (reply && reply.media) media = reply.media
    }
  } catch {
    /* no content script on this page (e.g. chrome://); send without media */
  }
  try {
    await sendToMOTH(config, {
      url,
      filename: directUrl ? guessFilename(directUrl) : undefined,
      referer: pageUrl || undefined,
      autoStart: true,
      media,
      ...(format && !directUrl ? { format } : {})
    })
    if (config.notify) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon128.png',
        title: 'Sent to Moth',
        message: directUrl || `Resolving media from ${pageUrl}`
      })
    }
  } catch (err) {
    if (err?.code === 'POLICY_BLOCKED') return
    // The app is probably closed: hand the URL to the OS, which cold-starts
    // Moth and queues the download. Same deep link the badge path uses
    // (see mediaProbe.js `buildDeepLink`); duplicated here because workers
    // cannot import page-context modules.
    let launched = false
    try {
      if (tab && tab.id != null && /^https?:/i.test(url)) {
        const formatParam = format && !directUrl ? `&format=${format}` : ''
        const link = `moth://download?url=${encodeURIComponent(url)}${formatParam}`
        await chrome.tabs.update(tab.id, { url: link })
        launched = true
      }
    } catch {
      /* no tab to hand over, or the OS refused; fall through to notify */
    }
    if (config.notify) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon128.png',
        title: launched ? 'Opening Moth…' : 'Moth is not running',
        message: launched ? (directUrl || `Resolving media from ${pageUrl}`) : String(err.message || err)
      })
    }
  }
})

/** Keep the badge honest about reachability. */
async function refreshStatus() {
  const config = await getConfig()
  const result = await diagnose(config)
  const ok = result.status === 'connected'
  await setBadge(
    ok ? '' : result.status === 'missing-token' ? '?' : '!',
    ok ? '#22c55e' : result.status === 'missing-token' ? '#64748b' : '#e11d48'
  )
  return { ...result, ok, configured: Boolean(config.token) }
}

chrome.runtime.onStartup.addListener(() => {
  void refreshStatus()
})
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'status') {
    void refreshStatus().then(sendResponse)
    return true
  }
  if (message?.type === 'send') {
    const config = message.config
    void sendToMOTH(config, message.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({
        ok: false,
        code: err?.code ?? 'REQUEST_FAILED',
        error: String(err.message || err)
      }))
    return true
  }
  if (message?.type === 'probe') {
    void diagnose(message.config)
      .then((result) => sendResponse({ ...result, ok: result.status === 'connected' }))
    return true
  }
  if (message?.type === 'check-policy') {
    const config = message.config ?? {}
    const decision = globalThis.MothTransferPolicy.transferDecision(message.payload ?? {}, config)
    sendResponse(decision)
    return false
  }
  return false
})
