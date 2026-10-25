/**
 * Icon barrel: Lucide glyphs with the app's default size.
 *
 * Inline SVG only, so the CSP can keep forbidding all remote assets (no
 * webfonts, no CDN). Call sites keep importing `Icon*` names from here so a
 * future set swap touches one file, not twenty.
 */

import type { SVGProps } from 'react'
import {
  Activity,
  AppWindow,
  Check,
  ChevronDown,
  Clapperboard,
  ClipboardPaste,
  Clock,
  ExternalLink,
  File,
  FileArchive,
  FileAudio,
  FileText,
  FileVideo,
  FolderOpen,
  Gauge,
  Globe2,
  GripVertical,
  Image,
  Link,
  List,
  Monitor,
  Moon,
  Music,
  Package,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Trash2,
  TriangleAlert,
  X,
  type LucideProps
} from 'lucide-react'
import type { DownloadCategory } from '@shared/types.js'

export type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function make(Component: React.ComponentType<LucideProps>) {
  return function Icon({ size = 16, ...props }: IconProps): React.ReactNode {
    return <Component size={size} aria-hidden {...(props as LucideProps)} />
  }
}

export const IconPlus = make(Plus)
export const IconPlay = make(Play)
export const IconPause = make(Pause)
export const IconRetry = make(RotateCcw)
export const IconClose = make(X)
export const IconTrash = make(Trash2)
export const IconFolder = make(FolderOpen)
export const IconExternal = make(ExternalLink)
export const IconSettings = make(Settings)
export const IconGrip = make(GripVertical)
export const IconCheck = make(Check)
export const IconAlert = make(TriangleAlert)
export const IconClock = make(Clock)
export const IconShield = make(ShieldCheck)
export const IconGauge = make(Gauge)
export const IconChart = make(Activity)
export const IconQueue = make(List)
export const IconBrowser = make(Globe2)
export const IconSun = make(Sun)
export const IconMoon = make(Moon)
export const IconMonitor = make(Monitor)
export const IconRefresh = make(RefreshCw)
export const IconFile = make(File)
export const IconSearch = make(Search)
export const IconPencil = make(Pencil)
export const IconVideo = make(Clapperboard)
export const IconAudio = make(Music)
export const IconLink = make(Link)
export const IconPaste = make(ClipboardPaste)
export const IconChevronDown = make(ChevronDown)

/** File-type glyph per download category, for badges and sidebar rows. */
export const CATEGORY_ICON: Record<DownloadCategory, (props: IconProps) => React.ReactNode> = {
  video: make(Clapperboard),
  audio: make(Music),
  document: make(FileText),
  archive: make(FileArchive),
  executable: make(AppWindow),
  image: make(Image),
  installer: make(Package),
  other: make(File)
}

/** Single-file audio/video variants (kept for pickers that list kinds). */
export const KIND_ICON = {
  video: make(FileVideo),
  audio: make(FileAudio)
} as const
