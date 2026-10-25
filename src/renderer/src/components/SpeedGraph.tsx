/**
 * Real-time throughput graph.
 *
 * Canvas rather than SVG: this repaints twice a second indefinitely, and a
 * few hundred SVG path nodes per frame is exactly the kind of thing that makes
 * a desktop app feel sluggish. A canvas redraw is a single composite.
 */

import { useEffect, useRef } from 'react'
import type { SpeedSample } from '@shared/types.js'
import { formatRate } from '../lib/format.js'

/**
 * Resolves a CSS custom property to a concrete colour.
 *
 * The canvas cannot use `var(--x)` in `strokeStyle`, so the token has to be read
 * out of the document. That keeps the graph on the same palette as everything
 * else, and re-reads on every paint so a theme switch takes effect at once.
 */
function cssVar(name: string, fallback = '#bce3fe'): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value.length > 0 ? value : fallback
}

interface Props {
  samples: SpeedSample[]
  /** Height in pixels. Deliberately small: this is an instrument strip. */
  height?: number
  /** Draw a ceiling line, e.g. the global speed limit. */
  limit?: number | null
}

export function SpeedGraph({ samples, height = 68, limit = null }: Props): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const samplesRef = useRef<SpeedSample[]>(samples)
  samplesRef.current = samples

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const draw = (): void => {
      const dpr = window.devicePixelRatio || 1
      const width = canvas.clientWidth
      const heightPx = canvas.clientHeight
      if (canvas.width !== width * dpr || canvas.height !== heightPx * dpr) {
        canvas.width = width * dpr
        canvas.height = heightPx * dpr
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, width, heightPx)

      const data = samplesRef.current

      // Baseline grid.
      context.strokeStyle = cssVar('--graph-grid')
      context.lineWidth = 1
      for (let i = 1; i < 3; i += 1) {
        const y = Math.round((heightPx / 3) * i) + 0.5
        context.beginPath()
        context.moveTo(0, y)
        context.lineTo(width, y)
        context.stroke()
      }

      // A window of all-zero samples is not a graph, it is a line on the floor.
      // Treat it as empty so the strip says so rather than looking broken.
      const peak = data.reduce((max, sample) => Math.max(max, sample.bytesPerSecond), 0)

      if (data.length < 2 || peak <= 0) {
        context.fillStyle = cssVar('--muted')
        context.globalAlpha = 0.5
        context.font = '11px ui-sans-serif, system-ui, sans-serif'
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        context.fillText('waiting for transfer data', width / 2, heightPx / 2)
        context.globalAlpha = 1
        return
      }

      // Scale to the window peak, but never below a sensible floor so a slow
      // transfer does not look like a full-height mountain range.
      const ceiling = limit && limit > 0 ? limit : 0
      const scaleMax = Math.max(peak * 1.15, ceiling * 1.1, 64 * 1024)

      const windowMs = 60_000
      const now = data[data.length - 1]?.t ?? Date.now()
      // Anchor the axis to the first sample when there is less than a full
      // window of history. Otherwise a freshly started app squeezes three
      // seconds of data into a sliver at the right edge, which reads as a
      // rendering glitch rather than as "not much data yet".
      const first = data[0]?.t ?? now
      const start = Math.min(first, now - windowMs)
      const span = Math.max(1000, now - start)
      const toX = (t: number): number => ((t - start) / span) * width
      const toY = (value: number): number =>
        heightPx - Math.min(1, value / scaleMax) * (heightPx - 4) - 2

      // Limit line.
      if (ceiling > 0 && ceiling <= scaleMax) {
        const y = toY(ceiling)
        context.strokeStyle = cssVar('--color-info')
        context.globalAlpha = 0.5
        context.setLineDash([4, 4])
        context.beginPath()
        context.moveTo(0, y)
        context.lineTo(width, y)
        context.stroke()
        context.setLineDash([])
        context.globalAlpha = 0.8
        context.fillStyle = cssVar('--color-info')
        context.font = '10px ui-monospace, monospace'
        context.textAlign = 'right'
        context.textBaseline = 'alphabetic'
        context.fillText('limit', width - 4, Math.max(10, y - 4))
        context.globalAlpha = 1
      }

      // Filled area.
      const gradient = context.createLinearGradient(0, 0, 0, heightPx)
      gradient.addColorStop(0, cssVar('--graph-fill-a'))
      gradient.addColorStop(1, cssVar('--graph-fill-b'))

      context.beginPath()
      context.moveTo(toX(data[0]?.t ?? start), heightPx)
      for (const sample of data) {
        context.lineTo(toX(sample.t), toY(sample.bytesPerSecond))
      }
      context.lineTo(toX(data[data.length - 1]?.t ?? now), heightPx)
      context.closePath()
      context.fillStyle = gradient
      context.fill()

      // Stroke.
      context.beginPath()
      data.forEach((sample, index) => {
        const x = toX(sample.t)
        const y = toY(sample.bytesPerSecond)
        if (index === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      })
      context.strokeStyle = cssVar('--color-brand-500')
      context.lineWidth = 1.5
      context.lineJoin = 'round'
      context.stroke()

      // Leading dot.
      const last = data[data.length - 1]
      if (last) {
        context.beginPath()
        context.arc(toX(last.t), toY(last.bytesPerSecond), 2.5, 0, Math.PI * 2)
        context.fillStyle = cssVar('--color-brand-400')
        context.fill()
      }
    }

    draw()

    const observer = new ResizeObserver(draw)
    observer.observe(canvas)

    // The graph reads its colours from CSS variables, so a theme switch has to
    // trigger a repaint or the canvas keeps the old palette.
    const themeObserver = new MutationObserver(draw)
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    })

    return () => {
      observer.disconnect()
      themeObserver.disconnect()
    }
  }, [samples, limit, height])

  const current = samples.length > 0 ? (samples[samples.length - 1]?.bytesPerSecond ?? 0) : 0
  const peak = samples.reduce((max, sample) => Math.max(max, sample.bytesPerSecond), 0)

  return (
    <canvas
      ref={canvasRef}
      className="block w-full"
      style={{ height }}
      role="img"
      aria-label={`Transfer rate over the last minute. Current ${formatRate(current)}, peak ${formatRate(peak)}`}
    />
  )
}
