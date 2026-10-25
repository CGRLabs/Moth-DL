/* Shared handoff policy for every extension entry point. */

;(function installMothTransferPolicy(root) {
  function isSiteExcluded(pageUrl, rules) {
    let hostname
    try {
      hostname = new URL(pageUrl).hostname.toLowerCase()
    } catch {
      return false
    }
    return String(rules || '').split(/\r?\n/).some((line) => {
      const rule = line.trim().toLowerCase()
      if (!rule) return false
      if (rule.startsWith('.')) {
        const bare = rule.slice(1)
        return hostname === bare || hostname.endsWith(rule)
      }
      return hostname === rule
    })
  }

  function extensionOf(url) {
    try {
      const path = new URL(url).pathname
      return /\.([a-z0-9]{1,12})$/i.exec(path)?.[1]?.toLowerCase() ?? ''
    } catch {
      return ''
    }
  }

  function looksLikeFilename(name) {
    return typeof name === 'string' && /\.[a-z0-9]{1,12}$/i.test(name)
  }

  /**
   * The filename a URL actually names, or undefined when it names none.
   *
   * A last path segment without an extension is not a name:
   * `https://host/download/pc/` redirects to `installer.exe`, and sending "pc"
   * would save the download with no extension at all. Only a segment that
   * carries an extension is trusted; otherwise the field is omitted so Moth
   * takes the real name from the response (`Content-Disposition`, final URL).
   */
  function filenameForUrl(url) {
    let last = ''
    try {
      const parsed = new URL(url)
      last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '')
    } catch {
      return undefined
    }
    return looksLikeFilename(last) ? last : undefined
  }

  /** Whether a name from the browser or a caller may be used as-is. */
  function isUsableFilename(name) {
    return looksLikeFilename(name)
  }

  function isExtensionExcluded(url, rules) {
    const extension = extensionOf(url)
    if (!extension) return false
    return String(rules || '')
      .split(/[\s,;]+/)
      .some((rule) => rule.replace(/^\./, '').toLowerCase() === extension)
  }

  function transferDecision(payload, preferences) {
    const pageUrl = payload?.referer || payload?.url || ''
    if (isSiteExcluded(pageUrl, preferences?.blacklist)) {
      return { allowed: false, reason: `The site ${new URL(pageUrl).hostname} is excluded.` }
    }
    const extension = extensionOf(payload?.url)
    if (extension && isExtensionExcluded(payload?.url, preferences?.excludedTypes)) {
      return { allowed: false, reason: `The .${extension} file type is excluded.` }
    }
    return { allowed: true, reason: null }
  }

  async function handoffAutomaticDownload(item, preferences, payload, send, cancel) {
    if (!preferences?.autoIntercept || !/^https?:/i.test(item?.url || '')) {
      return { handled: false, cancelled: false, reason: 'not-applicable' }
    }
    const decision = transferDecision(payload, preferences)
    if (!decision.allowed) {
      return { handled: true, cancelled: false, reason: decision.reason }
    }
    await send(payload)
    await cancel(item.id)
    return { handled: true, cancelled: true, reason: null }
  }

  root.MothTransferPolicy = {
    extensionOf,
    filenameForUrl,
    isExtensionExcluded,
    isSiteExcluded,
    isUsableFilename,
    transferDecision,
    handoffAutomaticDownload
  }
})(globalThis)
