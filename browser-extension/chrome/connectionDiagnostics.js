/* Connection checks used by the Chromium background service worker. */

;(function installMothConnectionDiagnostics(root) {
  const DEFAULT_PORT = 24678
  const PORT_SCAN_COUNT = 12
  const REQUEST_TIMEOUT_MS = 1200

  async function requestStatus(port, token, fetcher) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetcher(`http://127.0.0.1:${port}/status`, {
        method: 'GET',
        headers: token ? { 'x-moth-token': token } : {},
        signal: controller.signal
      })
      const body = response.status === 200 || response.status === 401
        ? await response.json().catch(() => null)
        : null
      return {
        status: response.status,
        isMoth:
          body?.app === 'moth-dlm' ||
          body?.error === 'Invalid or missing X-Moth-Token'
      }
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  }

  async function diagnoseConnection(config, fetcher = fetch) {
    const port = Number(config?.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { status: 'invalid-port', port: config?.port ?? null, foundPort: null }
    }
    if (!config?.token) return { status: 'missing-token', port, foundPort: null }

    const configuredStatus = await requestStatus(port, config.token, fetcher)
    if (configuredStatus?.status === 200 && configuredStatus.isMoth) {
      return { status: 'connected', port, foundPort: port }
    }
    if (configuredStatus?.status === 401 && configuredStatus.isMoth) {
      return { status: 'invalid-token', port, foundPort: port }
    }
    if (configuredStatus !== null) return { status: 'wrong-service', port, foundPort: null }

    const ports = Array.from({ length: PORT_SCAN_COUNT }, (_, index) => DEFAULT_PORT + index)
      .filter((candidate) => candidate !== port)
    const statuses = await Promise.all(ports.map((candidate) => requestStatus(candidate, '', fetcher)))
    const foundIndex = statuses.findIndex((result) => result?.isMoth)
    if (foundIndex >= 0) return { status: 'wrong-port', port, foundPort: ports[foundIndex] }
    return { status: 'unavailable', port, foundPort: null }
  }

  root.MothConnectionDiagnostics = { diagnoseConnection }
})(globalThis)
