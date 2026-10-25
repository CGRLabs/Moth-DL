/**
 * Minimal typed event bus.
 *
 * Node's `EventEmitter` is untyped and, more importantly, a throwing listener
 * propagates into the emitter and can abort the code that emitted the event.
 * The engine must never be derailed by a faulty UI listener, so this bus
 * isolates every listener in a try/catch and reports failures through the
 * logger instead.
 */

import { getLogger } from '../util/logger.js'

const log = getLogger('events')

export type Listener<T> = (payload: T) => void

export class EventBus<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>()

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    const wrapped = listener as Listener<never>
    set.add(wrapped)
    return () => {
      set?.delete(wrapped)
    }
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const off = this.on(event, (payload) => {
      off()
      listener(payload)
    })
    return off
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>)
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event)
    if (!set || set.size === 0) return
    // Copy so a listener may unsubscribe during dispatch.
    for (const listener of [...set]) {
      try {
        ;(listener as Listener<Events[K]>)(payload)
      } catch (err) {
        log.error('Event listener threw', { event: String(event), error: err })
      }
    }
  }

  listenerCount<K extends keyof Events>(event: K): number {
    return this.listeners.get(event)?.size ?? 0
  }

  removeAll(): void {
    this.listeners.clear()
  }
}

/** A promise with externally callable `resolve` / `reject`. */
export class Deferred<T> {
  readonly promise: Promise<T>
  private resolveFn!: (value: T | PromiseLike<T>) => void
  private rejectFn!: (reason?: unknown) => void
  private settled = false

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve
      this.rejectFn = reject
    })
  }

  resolve(value: T | PromiseLike<T>): void {
    if (this.settled) return
    this.settled = true
    this.resolveFn(value)
  }

  reject(reason?: unknown): void {
    if (this.settled) return
    this.settled = true
    this.rejectFn(reason)
  }

  get isSettled(): boolean {
    return this.settled
  }
}

/** Resolves after `ms`, without keeping the event loop alive. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('Aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Generates a compact, URL-safe, sortable-ish identifier. */
export function newId(): string {
  // randomUUID is used for the canonical id; this helper exists so tests and
  // future storage backends can swap the scheme in one place.
  return globalThis.crypto.randomUUID().replace(/-/g, '')
}
