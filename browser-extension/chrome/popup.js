/** Popup controller: reads and writes chrome.storage.local, talks to the worker. */

const $ = (id) => document.getElementById(id)

function showMessage(el, text, ok) {
  el.textContent = text
  el.className = `msg show ${ok ? 'ok' : 'err'}`
  setTimeout(() => {
    el.className = 'msg'
  }, 4000)
}

async function load() {
  const config = await chrome.storage.local.get({
    port: 24678,
    token: '',
    autoIntercept: false,
    notify: true,
    showBadge: true,
    blacklist: '',
    excludedTypes: ''
  })
  $('port').value = config.port
  $('token').value = config.token
  $('auto').checked = config.autoIntercept
  $('notify').checked = config.notify
  $('showBadge').checked = config.showBadge !== false
  $('blacklist').value = config.blacklist || ''
  $('excludedTypes').value = config.excludedTypes || ''
  await refreshStatus()
  const paired = await chrome.storage.local.get({ port: 24678, token: '' })
  if (paired.token) {
    $('port').value = paired.port
    $('token').value = paired.token
  }
}

async function currentConfig() {
  return {
    port: Number($('port').value) || 24678,
    token: $('token').value.trim(),
    autoIntercept: $('auto').checked,
    notify: $('notify').checked,
    showBadge: $('showBadge').checked,
    blacklist: $('blacklist').value,
    excludedTypes: $('excludedTypes').value
  }
}

async function refreshStatus() {
  const response = await chrome.runtime.sendMessage({ type: 'status' })
  const dot = $('dot')
  const text = $('statusText')
  if (response?.status === 'connected') {
    dot.className = 'dot on'
    text.textContent = `connected on port ${response.port}`
  } else if (response?.status === 'missing-token') {
    dot.className = 'dot'
    text.textContent = 'Not paired. Manual sends can still open Moth.'
  } else {
    dot.className = 'dot off'
    text.textContent = connectionMessage(response)
  }
}

function connectionMessage(result) {
  switch (result?.status) {
    case 'invalid-token':
      return `Moth is running on port ${result.port}, but rejected this token. Copy the current token from Moth Settings.`
    case 'wrong-port':
      return `Moth was found on port ${result.foundPort}, not ${result.port}. Update the port and test again.`
    case 'wrong-service':
      return `Something other than Moth answered on port ${result.port}. Check the port in Moth Settings.`
    case 'invalid-port':
      return 'The port must be a number between 1 and 65535.'
    case 'unavailable':
      return 'Moth is unreachable. Manual sends can try to open it; automatic handoff stays in the browser.'
    default:
      return 'Could not diagnose the Moth connection. Check the port and try again.'
  }
}

async function launchMoth(url, format, videoQuality) {
  try {
    const target = new URL(url)
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return false
    const params = new URLSearchParams({ url: target.href })
    if (format === 'audio' || format === 'video') params.set('format', format)
    if (format === 'video' && videoQuality) params.set('videoQuality', String(videoQuality))
    await chrome.tabs.create({ url: `moth://download?${params.toString()}` })
    return true
  } catch {
    return false
  }
}

async function sendOrLaunchMoth(config, payload) {
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'send', config, payload })
    if (reply?.ok) return { ok: true, message: 'Sent to Moth' }
    if (reply?.code === 'POLICY_BLOCKED') {
      return { ok: false, message: reply.error || 'This item is excluded by your transfer settings.' }
    }
    if (await launchMoth(payload.url, payload.format, payload.videoQuality)) {
      return { ok: true, message: 'Opening Moth. If it does not start, open Moth once and check Browser integration settings.' }
    }
    return { ok: false, message: reply?.error || 'Moth could not accept this download.' }
  } catch (error) {
    if (await launchMoth(payload.url, payload.format, payload.videoQuality)) {
      return { ok: true, message: 'Opening Moth. If it does not start, open Moth once and check Browser integration settings.' }
    }
    return { ok: false, message: String(error?.message || error) }
  }
}

$('save').addEventListener('click', async () => {
  const config = await currentConfig()
  await chrome.storage.local.set(config)
  const result = await chrome.runtime.sendMessage({ type: 'probe', config })
  await refreshStatus()
  showMessage(
    $('msg'),
    result?.ok ? `Saved. Moth is connected on port ${result.port}.` : `Saved. ${connectionMessage(result)}`,
    Boolean(result?.ok)
  )
})

$('test').addEventListener('click', async () => {
  const config = await currentConfig()
  const response = await chrome.runtime.sendMessage({ type: 'probe', config })
  showMessage($('msg'), response?.ok ? `Moth responded — pairing is good on port ${response.port}.` : connectionMessage(response), Boolean(response?.ok))
  await refreshStatus()
})

$('auto').addEventListener('change', async () => {
  const config = await currentConfig()
  await chrome.storage.local.set({ autoIntercept: config.autoIntercept })
})

$('notify').addEventListener('change', async () => {
  const config = await currentConfig()
  await chrome.storage.local.set({ notify: config.notify })
})

$('showBadge').addEventListener('change', async () => {
  const config = await currentConfig()
  await chrome.storage.local.set({ showBadge: config.showBadge })
})

$('blacklist').addEventListener('change', async () => {
  const config = await currentConfig()
  await chrome.storage.local.set({ blacklist: config.blacklist })
})

$('excludedTypes').addEventListener('change', async () => {
  const config = await currentConfig()
  await chrome.storage.local.set({ excludedTypes: config.excludedTypes })
})

$('findMedia').addEventListener('click', async () => {
  const results = $('mediaResults')
  results.replaceChildren()
  const button = $('findMedia')
  button.disabled = true
  button.textContent = 'Scanning…'
  $('scanMsg').className = 'msg'
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab || tab.id == null) throw new Error('No active tab is available')
    const config = await currentConfig()
    const pageDecision = globalThis.MothTransferPolicy.transferDecision(
      { url: tab.url, referer: tab.url },
      config
    )
    if (!pageDecision.allowed) {
      showMessage($('scanMsg'), pageDecision.reason, false)
      return
    }
    const discovery = await chrome.tabs.sendMessage(tab.id, { type: 'moth-discover-media' })
    if (!discovery?.ok) throw new Error('This page could not be scanned. Try reloading it first.')
    if (!Array.isArray(discovery.candidates) || discovery.candidates.length === 0) {
      showMessage($('scanMsg'), 'No media source was identified on this page.', false)
      return
    }
    if (!discovery.hasMediaSignal) {
      $('scanMsg').textContent = 'No direct media was detected. The resolver options below may still work.'
      $('scanMsg').className = 'msg show'
    }
    const allowedCandidates = discovery.candidates.filter((candidate) =>
      globalThis.MothTransferPolicy.transferDecision(
        {
          url: candidate.mode === 'resolve' ? discovery.pageUrl : candidate.url,
          referer: discovery.pageUrl
        },
        config
      ).allowed
    )
    if (allowedCandidates.length === 0) {
      showMessage($('scanMsg'), 'All detected files match your site or file-type exclusions.', false)
      return
    }
    for (const candidate of allowedCandidates) {
      const item = document.createElement('button')
      item.className = 'secondary'
      item.type = 'button'
      item.textContent = candidate.label || 'Media source'
      item.addEventListener('click', async () => {
        item.disabled = true
        const payload = candidate.mode === 'resolve'
          ? {
              url: discovery.pageUrl,
              format: candidate.format,
              ...(candidate.videoQuality ? { videoQuality: candidate.videoQuality } : {}),
              referer: discovery.pageUrl,
              autoStart: true
            }
          : { url: candidate.url, referer: discovery.pageUrl, autoStart: true }
        try {
          const result = await sendOrLaunchMoth(config, payload)
          showMessage($('scanMsg'), result.message, result.ok)
        } finally {
          item.disabled = false
        }
      })
      results.appendChild(item)
    }
  } catch (error) {
    showMessage($('scanMsg'), String(error?.message || error), false)
  } finally {
    button.disabled = false
    button.textContent = 'Scan current page'
  }
})

$('send').addEventListener('click', async () => {
  const url = $('url').value.trim()
  if (!url) return
  try {
    const config = await currentConfig()
    const result = await sendOrLaunchMoth(config, { url, autoStart: true })
    showMessage($('msg2'), result.message, result.ok)
    if (result.ok) $('url').value = ''
  } catch (error) {
    showMessage($('msg2'), String(error?.message || error), false)
  }
})

async function resolveManualUrl(format) {
  const url = $('url').value.trim()
  if (!url) {
    showMessage($('msg2'), 'Enter a page URL first.', false)
    return
  }
  try {
    const config = await currentConfig()
    const result = await sendOrLaunchMoth(config, { url, format, referer: url, autoStart: true })
    showMessage($('msg2'), result.ok && result.message === 'Sent to Moth' ? 'Sent page to Moth for resolution' : result.message, result.ok)
  } catch (error) {
    showMessage($('msg2'), String(error?.message || error), false)
  }
}

$('resolveVideo').addEventListener('click', () => void resolveManualUrl('video'))
$('resolveAudio').addEventListener('click', () => void resolveManualUrl('audio'))

$('openSettings').addEventListener('click', (event) => {
  event.preventDefault()
  chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id })
})

void load()
