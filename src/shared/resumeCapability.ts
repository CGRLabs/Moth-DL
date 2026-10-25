import { selectIfRangeValidator } from './ifRange.js'

export type ResumeSupport = 'safe' | 'restart' | 'unknown'

export interface ResumeCapability {
  support: ResumeSupport
  label: string
  explanation: string
}

export function getHttpResumeCapability(input: {
  fileSize: number | null
  acceptRanges: boolean
  etag?: string | null
  lastModified?: string | null
}): ResumeCapability {
  if (input.fileSize === null || input.fileSize <= 0) {
    return {
      support: 'unknown',
      label: 'Resume support not confirmed',
      explanation: 'Moth needs the file size and range/validator details before it can confirm safe resume.'
    }
  }

  if (!input.acceptRanges) {
    return {
      support: 'restart',
      label: 'Cannot safely resume — will restart',
      explanation: 'The server does not support byte ranges, so an interrupted transfer must start again.'
    }
  }

  if (!selectIfRangeValidator(input.etag, input.lastModified).value) {
    return {
      support: 'restart',
      label: 'Cannot safely resume — will restart',
      explanation: 'The server has no usable source validator, so Moth will discard partial progress rather than risk mixing file versions.'
    }
  }

  return {
    support: 'safe',
    label: 'Safe resume supported',
    explanation: 'The server supports byte ranges and provides a usable source validator.'
  }
}
