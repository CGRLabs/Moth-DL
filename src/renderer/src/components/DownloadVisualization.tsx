import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DownloadSnapshot, EngineStats } from '@shared/types.js'
import { formatBytes, formatDuration, formatRate, STATUS_LABELS } from '../lib/format.js'
import { CATEGORY_ICON, IconChart, IconClose, IconPause, IconPlay, IconPlus, IconRetry, IconSettings, IconTrash } from './Icons.js'
import { DownloadDetailsDialog } from './DownloadDetailsDialog.js'
import { TransferBadge } from './TransferBadge.js'
import { getTransferKind, transferEngineName } from '../lib/transfer.js'

interface Props {
  downloads: DownloadSnapshot[]
  stats: EngineStats | null
  activeConnectionsById: ReadonlyMap<string, number>
  developerMode: boolean
  globalSpeedLimit: number | null
  onClose: () => void
  onAdd: () => void
  onPause: (id: string) => void
  onResume: (id: string) => void
  onRetry: (id: string) => void
  onCancel: (id: string) => void
  onRemove: (id: string) => void
  onStartReview: (id: string) => void
  onConfigureReview: (id: string) => void
  onRefreshUrl: (id: string, url: string) => Promise<void>
  onVerifyDownload: NonNullable<React.ComponentProps<typeof DownloadDetailsDialog>['onVerifyDownload']>
  onReveal: (id: string) => void
  onOpenFolder: (id: string) => void
  onOpenFile: (id: string) => void
  onOpenSource: (id: string) => void
  onCopySource: (id: string) => void
  onCopyPath: (path: string) => void
  onSetSpeedLimit: (id: string, limit: number | null) => void
  onSetUploadSpeedLimit: (id: string, limit: number | null) => void
  onSetTorrentFiles: (id: string, indexes: number[]) => Promise<void>
  onSetPriority: (id: string, priority: number) => void
  onSetQuota: (id: string, quotaBytes: number | null) => void
  onSaveMetadata: (id: string, patch: Record<string, string | number | null>) => Promise<void>
  onWriteTags: (id: string) => Promise<{ written: boolean; reason?: string }>
  onSetGlobalSpeedLimit: (limit: number | null) => void
}

const FILE_LIMITS = [128, 300, 512, 1024, 2048].map((rate) => rate * 1024)
const GLOBAL_LIMITS = [128, 300, 512, 1024, 2048, 5120, 10240].map((rate) => rate * 1024)

type FlowDownload = Pick<
  DownloadSnapshot,
  | 'id'
  | 'filename'
  | 'category'
  | 'status'
  | 'fileSize'
  | 'downloadedBytes'
  | 'speed'
  | 'eta'
  | 'speedLimit'
  | 'url'
  | 'chunksComplete'
  | 'chunksTotal'
>

interface FlowPacket {
  id: number
  target: string
  startedAt: number
  durationMs: number
}

interface FlowPacketLine {
  id: number
  target: string
  x1: number
  y1: number
  x2: number
  y2: number
  x: number
  y: number
}

interface FlowRoute {
  key: string
  branch: string
  route: string
  active: boolean
}

interface FlowNodePosition {
  x: number
  y: number
}

interface FlowNodeDrag {
  key: string
  pointerId: number
  startX: number
  startY: number
  startPosition: FlowNodePosition
  position: FlowNodePosition
}

interface FlowCanvasPan {
  pointerId: number
  startX: number
  startY: number
  startOffset: FlowNodePosition
}

const FLOW_NODE_POSITIONS_KEY = 'moth.flowNodePositions.v1'

function loadFlowNodePositions(): Record<string, FlowNodePosition> {
  try {
    const serialized = window.localStorage.getItem(FLOW_NODE_POSITIONS_KEY)
    if (!serialized) return {}
    const parsed: unknown = JSON.parse(serialized)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Stored Flow positions must be an object')
    }
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, value]) => {
        if (
          typeof value !== 'object' ||
          value === null ||
          !('x' in value) ||
          !('y' in value) ||
          typeof value.x !== 'number' ||
          typeof value.y !== 'number' ||
          !Number.isFinite(value.x) ||
          !Number.isFinite(value.y)
        ) {
          console.warn(`Ignoring invalid saved Flow position for ${key}`)
          return []
        }
        return [[key, { x: value.x, y: value.y }]]
      })
    )
  } catch (error) {
    console.warn('Could not load saved Flow positions', error)
    return {}
  }
}

function saveFlowNodePositions(positions: Record<string, FlowNodePosition>): void {
  try {
    window.localStorage.setItem(FLOW_NODE_POSITIONS_KEY, JSON.stringify(positions))
  } catch (error) {
    console.warn('Could not save Flow positions', error)
  }
}

export function DownloadVisualization({
  downloads,
  stats,
  activeConnectionsById,
  developerMode,
  globalSpeedLimit,
  onClose,
  onAdd,
  onPause,
  onResume,
  onRetry,
  onCancel,
  onRemove,
  onStartReview,
  onConfigureReview,
  onRefreshUrl,
  onVerifyDownload,
  onReveal,
  onOpenFolder,
  onOpenFile,
  onOpenSource,

  onCopySource,
  onCopyPath,
  onSetSpeedLimit,
  onSetUploadSpeedLimit,
  onSetTorrentFiles,
  onSetPriority,
  onSetQuota,
  onSaveMetadata,
  onWriteTags,
  onSetGlobalSpeedLimit
}: Props): React.ReactElement {
  const panelRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detailsId, setDetailsId] = useState<string | null>(null)
  const [gatewayOpen, setGatewayOpen] = useState(false)
  const [flowTrunk, setFlowTrunk] = useState('')
  const [flowRoutes, setFlowRoutes] = useState<FlowRoute[]>([])
  const [flowPacketLines, setFlowPacketLines] = useState<FlowPacketLine[]>([])
  const [nodePositions, setNodePositions] = useState<Record<string, FlowNodePosition>>(loadFlowNodePositions)
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  const [narrowLayout, setNarrowLayout] = useState(() =>
    window.matchMedia('(max-width: 680px)').matches
  )
  const packetId = useRef(0)
  const nextTarget = useRef(0)
  const activeTargetsRef = useRef<{ key: string; rowIndex: number }[]>([])
  const routePaths = useRef(new Map<string, SVGPathElement>())
  const nodePorts = useRef(new Map<string, HTMLSpanElement>())
  const trackSvg = useRef<SVGSVGElement | null>(null)
  const mapElement = useRef<HTMLDivElement | null>(null)
  const ingressOutput = useRef<HTMLSpanElement | null>(null)
  const updateRoutesRef = useRef<() => void>(() => {})
  const activePackets = useRef<FlowPacket[]>([])
  const nodeDrag = useRef<FlowNodeDrag | null>(null)
  const canvasPan = useRef<FlowCanvasPan | null>(null)
  const [canvasOffset, setCanvasOffset] = useState<FlowNodePosition>({ x: 0, y: 0 })
  const [isCanvasPanning, setIsCanvasPanning] = useState(false)
  const flowSpeedRef = useRef(0)
  onCloseRef.current = onClose

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const updatePreference = (): void => setPrefersReducedMotion(mediaQuery.matches)
    mediaQuery.addEventListener('change', updatePreference)
    return () => mediaQuery.removeEventListener('change', updatePreference)
  }, [])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 680px)')
    const updateLayout = (): void => setNarrowLayout(mediaQuery.matches)
    mediaQuery.addEventListener('change', updateLayout)
    return () => mediaQuery.removeEventListener('change', updateLayout)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.target instanceof Element &&
        event.target.closest('[role="dialog"][aria-modal="true"]') !== panelRef.current
      ) return
      if (event.key === 'Escape') {
        event.stopPropagation()
        if (expandedId) {
          setExpandedId(null)
        } else {
          onCloseRef.current()
        }
        return
      }
      if (event.key !== 'Tab') return
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (!focusables?.length) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    panelRef.current?.querySelector<HTMLElement>('button')?.focus()
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [expandedId])

  const effectiveLimit = stats?.globalSpeedLimit ?? globalSpeedLimit
  const displayedDownloads: FlowDownload[] = downloads
  const branches = displayedDownloads.filter((download) => download.status !== 'completed' && download.status !== 'canceled')
  const rows: { downloads: FlowDownload[]; rowIndex: number }[] = []
  for (let index = 0; index < branches.length; index += 2) {
    rows.push({ downloads: branches.slice(index, index + 2), rowIndex: rows.length })
  }
  const activeTargets = rows.flatMap(({ downloads, rowIndex }) =>
    downloads.flatMap((download) =>
      download.status === 'downloading' || download.status === 'connecting'
        ? [{ key: download.id, rowIndex }]
        : []
    )
  )
  const activeTargetKey = activeTargets.map((target) => target.key).join('|')
  const branchLayoutKey = branches.map((download) => download.id).join('|')
  const rowHeight = narrowLayout ? 232 : 258
  const nodePositionKey = Object.entries(nodePositions)
    .map(([key, position]) => `${key}:${position.x},${position.y}`)
    .join('|')
  activeTargetsRef.current = activeTargets
  const activeSpeed = stats?.totalSpeed ?? branches.reduce((sum, download) => sum + download.speed, 0)
  flowSpeedRef.current = activeSpeed

  useLayoutEffect(() => {
    const map = mapElement.current
    const svg = trackSvg.current
    const outlet = ingressOutput.current
    if (!map || !svg || !outlet) return

    const updateRoutes = (): void => {
      const bounds = map.getBoundingClientRect()
      if (!bounds.width || !bounds.height) return
      svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`)
      svg.setAttribute('width', `${bounds.width}`)
      svg.setAttribute('height', `${bounds.height}`)

      const outletBounds = outlet.getBoundingClientRect()
      const inletX = outletBounds.left + outletBounds.width / 2 - bounds.left
      const trunkStartY = outletBounds.top + outletBounds.height / 2 - bounds.top
      const measuredRows = rows.map(({ downloads, rowIndex }) => {
        const measuredDownloads = downloads.flatMap((download, sideIndex) => {
          const port = nodePorts.current.get(download.id)
          if (!port) return []
          const portRect = port.getBoundingClientRect()
          return [{
            download,
            side: sideIndex === 0 ? 'left' as const : 'right' as const,
            x: portRect.left + portRect.width / 2 - bounds.left,
            y: portRect.top + portRect.height / 2 - bounds.top
          }]
        })
        if (measuredDownloads.length === 0) return null
        return {
          rowIndex,
          y: measuredDownloads.reduce((sum, item) => sum + item.y, 0) / measuredDownloads.length,
          downloads: measuredDownloads
        }
      })
        .filter((row): row is NonNullable<typeof row> => row !== null)
      const curveWidth = Math.min(34, bounds.width * 0.04)
      const branchRise = Math.min(52, rowHeight * 0.2)
      const trunkPoints = measuredRows.map((row) => ({
        x: inletX + Math.sin((row.rowIndex + 1) * 1.35) * curveWidth,
        y: row.y - branchRise
      }))

      const pathToPoint = (endIndex: number): string => {
        let path = `M${inletX} ${trunkStartY}`
        let previous = { x: inletX, y: trunkStartY }
        trunkPoints.slice(0, endIndex + 1).forEach((point) => {
          const deltaY = point.y - previous.y
          path += ` C${previous.x} ${previous.y + deltaY * 0.42}, ${point.x} ${point.y - deltaY * 0.42}, ${point.x} ${point.y}`
          previous = point
        })
        return path
      }
      setFlowTrunk(trunkPoints.length > 0 ? pathToPoint(trunkPoints.length - 1) : '')

      const measuredRoutes = measuredRows.flatMap((row, index) => {
        const split = trunkPoints[index]
        if (!split) return []
        const routePrefix = pathToPoint(index)
        return row.downloads.map(({ download, side, x, y }) => {
          const direction = side === 'left' ? -1 : 1
          const distance = Math.abs(x - split.x)
          const bend = Math.max(22, distance * 0.36)
          const curveDepth = Math.min(36, Math.max(22, (y - split.y) * 0.65))
          const curve = `C${split.x} ${split.y + curveDepth}, ${x - direction * bend} ${y}, ${x} ${y}`
          return {
            key: download.id,
            branch: `M${split.x} ${split.y} ${curve}`,
            route: `${routePrefix} ${curve}`,
            active: download.status === 'downloading' || download.status === 'connecting'
          }
        })
      })
      setFlowRoutes(measuredRoutes)
    }

    updateRoutesRef.current = updateRoutes
    updateRoutes()
    const observer = new ResizeObserver(updateRoutes)
    observer.observe(map)
    nodePorts.current.forEach((port) => observer.observe(port))
    observer.observe(outlet)
    return () => observer.disconnect()
  }, [activeTargetKey, branchLayoutKey, prefersReducedMotion, rowHeight])

  useLayoutEffect(() => {
    updateRoutesRef.current()
  }, [canvasOffset, nodePositionKey])

  useEffect(() => {
    const activeKeys = new Set(activeTargetsRef.current.map((target) => target.key))
    activePackets.current = activePackets.current.filter((packet) => activeKeys.has(packet.target))
    setFlowPacketLines((lines) => lines.filter((line) => activeKeys.has(line.target)))
    if (activeTargets.length === 0) return

    let lastLaunch = performance.now()
    let lastPaint = 0
    let frame = 0
    if (prefersReducedMotion) {
      activePackets.current = []
      setFlowPacketLines([])
      return
    }

    const animate = (): void => {
      const now = performance.now()
      const speedFactor = Math.min(3.5, Math.max(0.35, flowSpeedRef.current / 1_000_000))
      const launchInterval = Math.min(2000, Math.max(380, 1300 / Math.sqrt(speedFactor)))
      if (now - lastLaunch >= launchInterval) {
        const targets = activeTargetsRef.current
        const target = targets.length > 0 ? targets[nextTarget.current % targets.length] : undefined
        if (target) {
          const durationMs = Math.min(12_000, Math.max(1_800, (6_500 + target.rowIndex * 700) / Math.sqrt(speedFactor)))
          activePackets.current = [
            ...activePackets.current,
            { id: ++packetId.current, target: target.key, startedAt: now, durationMs }
          ]
          nextTarget.current = (nextTarget.current + 1) % targets.length
        }
        lastLaunch = now
      }

      if (now - lastPaint >= 1000 / 30) {
        const packetLines: FlowPacketLine[] = []
        const activeKeys = new Set(activeTargetsRef.current.map((target) => target.key))
        activePackets.current = activePackets.current.filter((packet) => {
          if (!activeKeys.has(packet.target)) return false
          const route = routePaths.current.get(packet.target)
          if (!route) return now - packet.startedAt < packet.durationMs
          const progress = Math.min(1, (now - packet.startedAt) / packet.durationMs)
          const length = route.getTotalLength()
          const head = route.getPointAtLength(length * progress)
          const tail = route.getPointAtLength(Math.max(0, length * progress - Math.min(16, length * 0.07)))
          packetLines.push({ id: packet.id, target: packet.target, x1: tail.x, y1: tail.y, x2: head.x, y2: head.y, x: head.x, y: head.y })
          return progress < 1
        })
        setFlowPacketLines(packetLines)
        lastPaint = now
      }
      frame = window.requestAnimationFrame(animate)
    }

    frame = window.requestAnimationFrame(animate)
    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [activeTargetKey, prefersReducedMotion])
  const activeCount = stats?.activeDownloads ?? branches.filter((download) =>
    download.status === 'downloading' || download.status === 'connecting'
  ).length

  const clampNodePosition = (
    node: HTMLElement,
    key: string,
    position: FlowNodePosition
  ): FlowNodePosition => {
    const map = mapElement.current
    if (!map) return position
    const mapBounds = map.getBoundingClientRect()
    const nodeBounds = node.getBoundingClientRect()
    const currentPosition = nodePositions[key] ?? { x: 0, y: 0 }
    const originX = nodeBounds.left - mapBounds.left - currentPosition.x
    const originY = nodeBounds.top - mapBounds.top - currentPosition.y
    return {
      x: Math.min(mapBounds.width - originX - nodeBounds.width, Math.max(-originX, position.x)),
      y: Math.min(mapBounds.height - originY - nodeBounds.height, Math.max(-originY, position.y))
    }
  }

  const beginNodeDrag = (event: React.PointerEvent<HTMLElement>, key: string): void => {
    if (!event.isPrimary || event.button !== 0) return
    const target = event.target
    if (!(target instanceof Element) || target.closest('button, select, input, textarea, a')) return
    event.preventDefault()
    const position = nodePositions[key] ?? { x: 0, y: 0 }
    nodeDrag.current = {
      key,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPosition: position,
      position
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const moveDraggedNode = (event: React.PointerEvent<HTMLElement>): void => {
    const drag = nodeDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const position = clampNodePosition(event.currentTarget, drag.key, {
      x: drag.startPosition.x + event.clientX - drag.startX,
      y: drag.startPosition.y + event.clientY - drag.startY
    })
    drag.position = position
    setNodePositions((positions) => ({ ...positions, [drag.key]: position }))
  }

  const finishNodeDrag = (event: React.PointerEvent<HTMLElement>): void => {
    const drag = nodeDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    nodeDrag.current = null
    const positions = { ...nodePositions, [drag.key]: drag.position }
    setNodePositions(positions)
    saveFlowNodePositions(positions)
  }

  const beginCanvasPan = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!event.isPrimary || event.button !== 0) return
    const target = event.target
    if (
      !(target instanceof Element) ||
      target.closest('.flow-node, .flow-ingress, button, select, input, textarea, a')
    ) return
    event.preventDefault()
    canvasPan.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffset: canvasOffset
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setIsCanvasPanning(true)
  }

  const moveCanvasPan = (event: React.PointerEvent<HTMLDivElement>): void => {
    const pan = canvasPan.current
    if (!pan || pan.pointerId !== event.pointerId) return
    setCanvasOffset({
      x: pan.startOffset.x + event.clientX - pan.startX,
      y: pan.startOffset.y + event.clientY - pan.startY
    })
  }

  const finishCanvasPan = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (canvasPan.current?.pointerId !== event.pointerId) return
    canvasPan.current = null
    setIsCanvasPanning(false)
  }

  const moveNodeWithKeyboard = (
    event: React.KeyboardEvent<HTMLDivElement>,
    key: string
  ): void => {
    if (!event.altKey) return
    const delta = event.key === 'ArrowLeft'
      ? { x: -24, y: 0 }
      : event.key === 'ArrowRight'
        ? { x: 24, y: 0 }
        : event.key === 'ArrowUp'
          ? { x: 0, y: -24 }
          : event.key === 'ArrowDown'
            ? { x: 0, y: 24 }
            : null
    if (!delta) return
    const node = event.currentTarget.closest<HTMLElement>('.flow-node')
    if (!node) return
    event.preventDefault()
    const position = clampNodePosition(node, key, {
      x: (nodePositions[key]?.x ?? 0) + delta.x,
      y: (nodePositions[key]?.y ?? 0) + delta.y
    })
    const nextPositions = { ...nodePositions, [key]: position }
    setNodePositions(nextPositions)
    saveFlowNodePositions(nextPositions)
  }

  const renderNode = (download: FlowDownload, side: 'left' | 'right'): React.ReactElement => {
    const progress = download.fileSize > 0
      ? Math.min(100, Math.max(0, download.downloadedBytes / download.fileSize * 100))
      : 0
    const active = download.status === 'downloading' || download.status === 'connecting'
    const expanded = expandedId === download.id
    const FileIcon = CATEGORY_ICON[download.category]
    const currentLimit = download.speedLimit
    const limits = currentLimit !== null && !FILE_LIMITS.includes(currentLimit)
      ? [currentLimit, ...FILE_LIMITS]
      : FILE_LIMITS

    return (
      <article
        key={download.id}
        className={`flow-node flow-node-${side} ${active ? 'flow-node-active' : 'flow-node-idle'} ${expanded ? 'flow-node-expanded' : ''} ${nodeDrag.current?.key === download.id ? 'flow-node-dragging' : ''}`}
        style={{
          '--flow-drag-x': `${nodePositions[download.id]?.x ?? 0}px`,
          '--flow-drag-y': `${nodePositions[download.id]?.y ?? 0}px`
        } as React.CSSProperties}
        aria-label={`${download.filename}, ${STATUS_LABELS[download.status] ?? download.status}, ${Math.round(progress)} percent`}
        onPointerDown={(event) => beginNodeDrag(event, download.id)}
        onPointerMove={moveDraggedNode}
        onPointerUp={finishNodeDrag}
        onPointerCancel={finishNodeDrag}
      >
        <span
          className="flow-node-port"
          aria-hidden="true"
          ref={(element) => {
            if (element) nodePorts.current.set(download.id, element)
            else nodePorts.current.delete(download.id)
          }}
        />
        <div
          className="flow-node-heading flow-node-drag-handle"
          role="group"
          tabIndex={0}
          aria-label={`Move ${download.filename}; drag or use Alt and arrow keys`}
          onKeyDown={(event) => moveNodeWithKeyboard(event, download.id)}
        >
          <span className="flow-node-icon"><FileIcon size={18} /></span>
          <TransferBadge url={download.url} title={`Transferred by ${transferEngineName(getTransferKind(download.url)).toLowerCase()}`} />
          <span className="flow-node-name" title={download.filename}>{download.filename}</span>
        </div>

        <div
          className="flow-progress"
          role="progressbar"
          aria-label={`Progress for ${download.filename}`}
          aria-valuenow={Math.round(progress)}
          aria-valuemin={0}
          aria-valuemax={100}
          style={{ '--flow-progress': `${progress}%` } as React.CSSProperties}
        >
          <div className="flow-progress-inner">
            <span className="flow-progress-value">{Math.round(progress)}<small>%</small></span>
            <span className="flow-progress-status">{STATUS_LABELS[download.status] ?? download.status}</span>
          </div>
        </div>

        <div className="flow-node-rate">
          <span>{formatRate(download.speed)}</span>
          {download.eta !== null ? <span className="flow-node-eta">{formatDuration(download.eta)}</span> : null}
        </div>

        <p className="flow-node-engine">
          {getTransferKind(download.url) === 'http'
            ? `${download.chunksComplete} / ${download.chunksTotal} chunks verified`
            : `${transferEngineName(getTransferKind(download.url))} · ${formatBytes(download.downloadedBytes)}`}
        </p>

        <div className={`flow-node-actions flow-actions-${side}`}>
          <button
            type="button"
            onClick={() => {
              setDetailsId(download.id)
            }}
            aria-label={`Show details for ${download.filename}`}
            title="Show all details"
            className="flow-details-action"
          >
            <IconChart size={13} />
            <span>Details</span>
          </button>
          {download.status === 'downloading' || download.status === 'connecting' ? (
            <button
              type="button"
              onClick={() => onPause(download.id)}
              aria-label={`Pause ${download.filename}`}
              title="Pause"
              className="flow-icon-action"
            >
              <IconPause size={14} />
            </button>
          ) : null}
          {download.status !== 'completed' &&
          download.status !== 'canceled' &&
          download.status !== 'failed' &&
          download.status !== 'downloading' &&
          download.status !== 'connecting' &&
          download.status !== 'review' ? (
            <button
              type="button"
              onClick={() => onResume(download.id)}
              aria-label={`Resume ${download.filename}`}
              title="Resume"
              className="flow-icon-action"
            >
              <IconPlay size={14} />
            </button>
          ) : null}
          {download.status === 'failed' ? (
            <button
              type="button"
              onClick={() => onRetry(download.id)}
              aria-label={`Retry ${download.filename}`}
              title="Retry"
              className="flow-icon-action"
            >
              <IconRetry size={14} />
            </button>
          ) : null}
          {download.status !== 'completed' && download.status !== 'canceled' && download.status !== 'failed' ? (
            <button
              type="button"
              onClick={() => onCancel(download.id)}
              aria-label={`Cancel ${download.filename}`}
              title="Cancel"
              className="flow-icon-action flow-icon-danger"
            >
              <IconTrash size={14} />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setExpandedId(expanded ? null : download.id)}
            aria-expanded={expanded}
            aria-label={`Details and speed limit for ${download.filename}`}
            title="Details and speed limit"
            className="flow-icon-action"
          >
            <IconSettings size={14} />
          </button>
        </div>

        {expanded ? (
          <div className="flow-node-detail">
            <p>{formatBytes(download.downloadedBytes)} of {download.fileSize > 0 ? formatBytes(download.fileSize) : 'unknown size'}</p>
            <label>
              Speed cap
              <select
                value={currentLimit ?? ''}
                aria-label={`Speed cap for ${download.filename}`}
                onChange={(event) => {
                  const limit = event.target.value ? Number(event.target.value) : null
                  onSetSpeedLimit(download.id, limit)
                }}
              >
                <option value="">Unlimited</option>
                {limits.map((limit) => <option key={limit} value={limit}>{formatRate(limit)}</option>)}
              </select>
            </label>
          </div>
        ) : null}
      </article>
    )
  }

  return (
    <section
      ref={panelRef}
      className="download-visualizer flow-stage fixed inset-0 z-[60] overflow-hidden text-ink"
      role="dialog"
      aria-modal="true"
      aria-label="Download flow map"
    >
      <div className="flow-hud" aria-label="Network overview">
        <span>{formatRate(activeSpeed)}</span>
        <i aria-hidden="true" />
        <span>{branches.length} files</span>
        <i aria-hidden="true" />
        <span>{activeCount} active</span>
        {effectiveLimit !== null ? <small>cap {formatRate(effectiveLimit)}</small> : null}
      </div>

      <div className="flow-toolbar">
        <button
          type="button"
          onClick={onAdd}
          aria-label="Add download"
          title="Add download"
          className="flow-toolbar-button"
        >
          <IconPlus size={15} />
        </button>
        <button type="button" onClick={onClose} aria-label="Exit flow map" title="Exit flow map" className="flow-toolbar-button">
          <IconClose size={15} />
        </button>
      </div>

      <div
        className={`flow-canvas ${isCanvasPanning ? 'flow-canvas-panning' : ''}`}
        onPointerDown={beginCanvasPan}
        onPointerMove={moveCanvasPan}
        onPointerUp={finishCanvasPan}
        onPointerCancel={finishCanvasPan}
      >
        <div
          className="flow-map"
          ref={mapElement}
          style={{ translate: `${canvasOffset.x}px ${canvasOffset.y}px` }}
        >
          <div className="flow-ingress">
            <span className="flow-ingress-orbit" aria-hidden="true" />
            <span className="flow-ingress-output" aria-hidden="true" ref={ingressOutput} />
            <button
              type="button"
              className="flow-ingress-core"
              aria-label="Edit WAN speed cap"
              aria-expanded={gatewayOpen}
              onClick={() => setGatewayOpen((open) => !open)}
            >
              <span>WAN</span>
            </button>
            <span className="flow-ingress-caption">INTERNET GATEWAY</span>
            {gatewayOpen ? (
              <div className="flow-wan-panel">
                <label htmlFor="flow-wan-limit">Global speed cap</label>
                <select
                  id="flow-wan-limit"
                  value={effectiveLimit ?? ''}
                  onChange={(event) => {
                    const limit = event.target.value ? Number(event.target.value) : null
                    onSetGlobalSpeedLimit(limit)
                  }}
                >
                  <option value="">Unlimited</option>
                  {effectiveLimit !== null && !GLOBAL_LIMITS.includes(effectiveLimit) ? (
                    <option value={effectiveLimit}>{formatRate(effectiveLimit)}</option>
                  ) : null}
                  {GLOBAL_LIMITS.map((limit) => <option key={limit} value={limit}>{formatRate(limit)}</option>)}
                </select>
                <small>Applies to shared HTTP traffic.</small>
              </div>
            ) : null}
          </div>

          {branches.length > 0 ? (
            <svg
              ref={trackSvg}
              className="flow-track-svg"
              viewBox="0 0 1 1"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {flowRoutes.length > 0 ? (
                <path
                  className="flow-trunk-track"
                  d={flowTrunk}
                  style={{ strokeWidth: 1.4 + Math.min(1.2, activeSpeed / 4_000_000) }}
                />
              ) : null}
              {flowRoutes.map((route) => (
                <g key={route.key}>
                  <path
                    className="flow-branch-track"
                    d={route.branch}
                    data-flow={route.active ? 'active' : 'idle'}
                    style={{ strokeWidth: route.active ? 1.4 : 1 }}
                  />
                  {route.active ? (
                    <path
                      className="flow-route-measure"
                      ref={(element) => {
                        if (element) routePaths.current.set(route.key, element)
                        else routePaths.current.delete(route.key)
                      }}
                      d={route.route}
                    />
                  ) : null}
                </g>
              ))}
              {flowPacketLines.map((packet) => (
                <g key={packet.id} className="flow-packet-group">
                  <line
                    className="flow-packet-glow"
                    x1={packet.x1}
                    y1={packet.y1}
                    x2={packet.x2}
                    y2={packet.y2}
                  />
                  <line
                    className="flow-packet"
                    x1={packet.x1}
                    y1={packet.y1}
                    x2={packet.x2}
                    y2={packet.y2}
                  />
                  <circle className="flow-packet-head" cx={packet.x} cy={packet.y} r="1.15" />
                </g>
              ))}
            </svg>
          ) : null}

          {branches.length === 0 ? (
            <div className="flow-empty">
              <span>No download streams</span>
              <button type="button" onClick={onAdd}>Connect a file</button>
            </div>
          ) : (
            <div
              className="flow-tree"
              aria-label="Download streams"
              style={{
                '--flow-row-height': `${rowHeight}px`,
              } as React.CSSProperties}
            >
              {rows.map(({ downloads, rowIndex }) => (
                <div className="flow-row" key={downloads[0]?.id ?? rowIndex}>
                  {downloads.map((download, sideIndex) =>
                    renderNode(download, sideIndex === 0 ? 'left' : 'right')
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {detailsId ? (() => {
        const selectedDownload = downloads.find((download) => download.id === detailsId)
        return selectedDownload ? (
          <DownloadDetailsDialog
            key={selectedDownload.id}
            download={selectedDownload}
            activeConnections={activeConnectionsById.get(selectedDownload.id) ?? 0}
            developerMode={developerMode}
            onClose={() => setDetailsId(null)}
            onPause={onPause}
            onResume={onResume}
            onRetry={onRetry}
            onCancel={onCancel}
            onRemove={onRemove}
            onStartReview={onStartReview}
            onConfigureReview={onConfigureReview}
            onRefreshUrl={onRefreshUrl}
            onVerifyDownload={onVerifyDownload}
            onReveal={onReveal}
            onOpenFolder={onOpenFolder}
            onOpenFile={onOpenFile}
            onOpenSource={onOpenSource}
            onCopySource={onCopySource}
            onCopyPath={onCopyPath}
            onSetPriority={onSetPriority}
            onSetSpeedLimit={onSetSpeedLimit}
            onSetUploadSpeedLimit={onSetUploadSpeedLimit}
            onSetTorrentFiles={onSetTorrentFiles}
            onSetQuota={onSetQuota}
            onSaveMetadata={onSaveMetadata}
            onWriteTags={onWriteTags}
          />
        ) : null
      })() : null}
    </section>
  )
}
