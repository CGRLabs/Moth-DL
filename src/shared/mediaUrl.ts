export function isYouTubeUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      (host === 'youtu.be' ||
        host === 'youtube.com' ||
        host.endsWith('.youtube.com') ||
        host === 'youtube-nocookie.com' ||
        host.endsWith('.youtube-nocookie.com'))
  } catch {
    return false
  }
}

export function isYouTubePlaylistUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim())
    const host = url.hostname.toLowerCase()
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') &&
      Boolean(url.searchParams.get('list'))
  } catch {
    return false
  }
}
