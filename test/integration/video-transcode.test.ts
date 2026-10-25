import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { normalizeVideoToMp4, transcodeToMp3, validateVideoFile } from '../../src/main/video/transcode.js'
import { emptyTags } from '@shared/media.js'
import { writeTagsToFile } from '../../src/main/media/write.js'

function findFfmpeg(): string | null {
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

const ffmpegPath = findFfmpeg()
const ffmpegEncoders = ffmpegPath
  ? spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout
  : ''
const canCreateVp9OpusFixture = /libvpx-vp9/.test(ffmpegEncoders) && /libopus/.test(ffmpegEncoders)
const canCreateAv1OpusFixture = /libsvtav1/.test(ffmpegEncoders) && /libopus/.test(ffmpegEncoders)

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath!, args, { stdio: 'ignore', windowsHide: true })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`FFmpeg exited with code ${code}`))
    })
  })
}

describe('FFmpeg media validation and conversion', () => {
  it.skipIf(!ffmpegPath)('writes a decodable MP3 using the application conversion path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moth-transcode-test-'))
    try {
      const sourcePath = join(directory, 'source.wav')
      const outputPath = join(directory, 'result.mp3')
      await runFfmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=1000:duration=1',
        '-c:a',
        'pcm_s16le',
        sourcePath
      ])

      await transcodeToMp3(sourcePath, outputPath, { ffmpegPath: ffmpegPath! })

      expect((await stat(outputPath)).size).toBeGreaterThan(0)
      await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-i', outputPath, '-f', 'null', '-'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(!ffmpegPath)('accepts complete video/audio media and rejects truncated media', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moth-video-validation-test-'))
    try {
      const validPath = join(directory, 'valid.mp4')
      await runFfmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=160x120:rate=24:duration=1',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=1000:duration=1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        validPath
      ])

      const streams = await validateVideoFile(ffmpegPath!, validPath, { requireAudio: true })
      expect(streams.videoCodec).toBe('h264')
      expect(streams.audioCodec).toBe('aac')
      expect(streams.hasAudio).toBe(true)
      expect(streams.width).toBe(160)
      expect(streams.height).toBe(120)

      const bytes = await readFile(validPath)
      const truncatedPath = join(directory, 'truncated.mp4')
      await writeFile(truncatedPath, bytes.subarray(0, Math.floor(bytes.length / 2)))
      await expect(validateVideoFile(ffmpegPath!, truncatedPath, { requireAudio: true })).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(!ffmpegPath)('preserves full video decodability when embedding MP4 tags', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moth-video-tag-test-'))
    try {
      const videoPath = join(directory, 'tagged.mp4')
      await runFfmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=160x120:rate=24:duration=1',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=1000:duration=1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        videoPath
      ])

      const result = await writeTagsToFile(videoPath, { ...emptyTags('mp4'), title: 'Tagged video' })
      expect(result.written).toBe(true)
      await expect(validateVideoFile(ffmpegPath!, videoPath, { requireAudio: true })).resolves.toMatchObject({
        videoCodec: 'h264',
        audioCodec: 'aac',
        hasAudio: true
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(!ffmpegPath)('rejects a video that is missing its expected audio stream', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moth-video-no-audio-test-'))
    try {
      const videoPath = join(directory, 'silent.mp4')
      await runFfmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=160x120:rate=24:duration=1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-an',
        videoPath
      ])
      await expect(validateVideoFile(ffmpegPath!, videoPath, { requireAudio: true }))
        .rejects.toThrow(/missing its expected audio stream/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(!ffmpegPath || !canCreateVp9OpusFixture)(
    'normalizes a VP9/Opus WebM into a decodable H.264/AAC MP4',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'moth-video-codec-matrix-'))
      try {
        const videoPath = join(directory, 'source.webm')
        await runFfmpeg([
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc=size=160x120:rate=24:duration=1',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=1',
          '-c:v',
          'libvpx-vp9',
          '-deadline',
          'realtime',
          '-cpu-used',
          '8',
          '-c:a',
          'libopus',
          videoPath
        ])

        await expect(validateVideoFile(ffmpegPath!, videoPath, { requireAudio: true })).resolves.toMatchObject({
          videoCodec: 'vp9',
          audioCodec: 'opus',
          hasAudio: true
        })
        await expect(normalizeVideoToMp4(videoPath, { ffmpegPath: ffmpegPath! })).resolves.toBe(true)
        await expect(validateVideoFile(ffmpegPath!, videoPath, { requireAudio: true })).resolves.toMatchObject({
          videoCodec: 'h264',
          audioCodec: 'aac',
          hasAudio: true
        })
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(!ffmpegPath || !canCreateAv1OpusFixture)(
    'normalizes an AV1/Opus Matroska into a decodable H.264/AAC MP4',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'moth-video-av1-test-'))
      try {
        const videoPath = join(directory, 'source.mkv')
        await runFfmpeg([
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc=size=160x120:rate=24:duration=1',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=660:duration=1',
          '-c:v',
          'libsvtav1',
          '-preset',
          '12',
          '-crf',
          '50',
          '-c:a',
          'libopus',
          videoPath
        ])

        await expect(validateVideoFile(ffmpegPath!, videoPath, { requireAudio: true })).resolves.toMatchObject({
          videoCodec: 'av1',
          audioCodec: 'opus',
          hasAudio: true
        })
        await expect(normalizeVideoToMp4(videoPath, { ffmpegPath: ffmpegPath! })).resolves.toBe(true)
        await expect(validateVideoFile(ffmpegPath!, videoPath, { requireAudio: true })).resolves.toMatchObject({
          videoCodec: 'h264',
          audioCodec: 'aac',
          hasAudio: true
        })
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )
})
