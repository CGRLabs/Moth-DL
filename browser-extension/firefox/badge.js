/**
 * Floating in-page badge that offers "Send to Moth" over media.
 *
 * One fixed-position 26px circle anchored to the target's top-right corner.
 * It never follows the cursor: the badge is a page overlay, so cursor
 * tracking would cover the content the user is trying to see.
 *
 * Positioning is inline styles; visuals live in a single injected `<style>`
 * so no extra web-accessible CSS file (and its manifest entry) is needed.
 * Motion uses CSS transitions only, disabled under `prefers-reduced-motion`.
 */

(function installMothBadge(root) {
const STYLE_ID = 'moth-media-badge-style'
const SHOW_DELAY_MS = 250
const HIDE_DELAY_MS = 400
const REFUSAL_MS = 1500

const CSS = [
  '.moth-media-badge{',
  'position:fixed;width:26px;height:26px;border-radius:50%;z-index:2147483000;',
  'display:grid;place-items:center;cursor:pointer;border:0;padding:0;',
  'background:rgba(30,41,59,.72);color:#fff;font-size:14px;line-height:1;',
  'opacity:0;pointer-events:none;transform:scale(.9);',
  'transition:opacity .16s ease,transform .16s ease,background .16s ease;',
  '}',
  '.moth-media-badge.is-prominent{',
  'width:106px;height:40px;border-radius:20px;display:flex;gap:7px;',
  'background:rgba(15,23,42,.94);font-size:12px;font-weight:650;',
  'box-shadow:0 3px 14px rgba(0,0,0,.45);',
  '}',
  '.moth-media-badge.is-prominent .moth-badge-label{display:inline;}',
  '.moth-media-badge .moth-badge-label{display:none;}',
  '.moth-media-badge.is-visible{opacity:.72;pointer-events:auto;}',
  '.moth-media-badge.is-prominent.is-visible{opacity:.96;}',
  '.moth-media-badge.is-visible:hover,.moth-media-badge.is-visible:focus-visible{',
  'opacity:1;transform:scale(1.12);background:rgba(79,124,255,.95);outline:2px solid #fff;',
  '}',
  '.moth-media-badge.is-refused{opacity:.55;background:rgba(100,116,139,.85);transform:scale(1);}',
  '.moth-media-picker{',
  'position:fixed;z-index:2147483001;min-width:235px;max-width:300px;max-height:340px;overflow-y:auto;',
  'background:rgba(15,23,42,.96);border:1px solid rgba(148,163,184,.35);border-radius:10px;',
  'padding:4px;box-shadow:0 8px 28px rgba(0,0,0,.45);font-family:system-ui,sans-serif;',
  '}',
  '.moth-media-picker button{',
  'display:flex;width:100%;align-items:baseline;gap:8px;border:0;background:transparent;',
  'color:#e2e8f0;font-size:12px;text-align:left;padding:7px 9px;border-radius:7px;cursor:pointer;',
  '}',
  '.moth-media-picker button:hover,.moth-media-picker button:focus-visible{background:rgba(79,124,255,.9);color:#fff;outline:none;}',
  '.moth-media-picker .moth-pick-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.moth-media-picker .moth-pick-kind{flex:none;font-size:10px;opacity:.65;text-transform:uppercase;}',
  '.moth-media-picker .moth-pick-now{flex:none;font-size:10px;color:#7dd3fc;}',
  '@media (prefers-reduced-motion:reduce){',
  '.moth-media-badge{transition:none;}',
  '}'
].join('\n')

function ensureStyle(document) {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  const parent = document.head || document.documentElement
  if (parent) parent.appendChild(style)
}

function anchorPoint(rect) {
  // Fixed positioning is viewport-relative, so the rect applies directly.
  return { left: rect.right - 13, top: rect.top - 13 }
}

/**
 * @param {{ onActivate: () => void, prominent?: boolean }} options
 */
function createBadge(options) {
  const document = globalThis.document
  const onActivate = options && options.onActivate
  const element = document.createElement('div')
  ensureStyle(document)
  element.className = 'moth-media-badge'
  element.setAttribute('tabindex', '0')
  element.setAttribute('role', 'button')
  element.setAttribute('aria-label', 'Send media to Moth')
  element.title = 'Send to Moth'
  const icon = document.createElement('span')
  icon.setAttribute('aria-hidden', 'true')
  icon.textContent = '↓'
  const label = document.createElement('span')
  label.className = 'moth-badge-label'
  label.textContent = 'Download'
  element.append(icon, label)
  if (options && options.prominent) element.classList.add('is-prominent')
  document.body.appendChild(element)

  let lastRect = null
  let lastAnchor = null
  let showTimer = 0
  let hideTimer = 0
  let refusalTimer = 0
  let picker = null
  let pickerPick = null

  function place() {
    if (!lastRect) return
    const point = anchorPoint(lastRect)
    element.style.left = `${Math.max(0, point.left)}px`
    element.style.top = `${Math.max(0, point.top)}px`
  }

  function clearTimers() {
    if (showTimer) window.clearTimeout(showTimer)
    if (hideTimer) window.clearTimeout(hideTimer)
    showTimer = 0
    hideTimer = 0
  }

  function showAt(anchorRect, anchor) {
    lastRect = anchorRect
    if (anchor !== undefined) lastAnchor = anchor || null
    // Re-read the live rect when the anchor survives, so layout shifts
    // and playback resizes move the badge rather than stranding it.
    try {
      if (lastAnchor && typeof lastAnchor.getBoundingClientRect === 'function') {
        lastRect = lastAnchor.getBoundingClientRect()
      }
    } catch {
      /* a detached node keeps its last known rect */
    }
    place()
    clearTimers()
    showTimer = window.setTimeout(() => {
      showTimer = 0
      element.classList.add('is-visible')
    }, SHOW_DELAY_MS)
  }

  function hide() {
    clearTimers()
    hidePicker()
    hideTimer = window.setTimeout(() => {
      hideTimer = 0
      element.classList.remove('is-visible')
      lastRect = null
      lastAnchor = null
    }, HIDE_DELAY_MS)
  }

  /**
   * Quality picker: one row per variant, opened when the badge covers an
   * element with several discrete files. Presentational only — the variant
   * list is built by `collectVariants`, so there is nothing here Node needs
   * to test. Dismisses on pick, Escape, or an outside pointer press.
   */
  function hidePicker() {
    if (picker && picker.parentNode) picker.parentNode.removeChild(picker)
    picker = null
    pickerPick = null
    try {
      document.removeEventListener('pointerdown', onOutsidePicker, true)
      document.removeEventListener('keydown', onPickerKey, true)
    } catch {
      /* never attached, or a hostile document */
    }
  }

  function onOutsidePicker(event) {
    try {
      const target = event.target
      if (picker && picker.contains(target)) return
      if (target === element || element.contains(target)) return
    } catch {
      /* fall through to dismiss */
    }
    hidePicker()
  }

  function onPickerKey(event) {
    if (event && event.key === 'Escape') {
      try {
        if (typeof event.stopPropagation === 'function') event.stopPropagation()
      } catch {
        /* dismissed regardless */
      }
      hidePicker()
      try {
        element.focus()
      } catch {
        /* keyboard context is a courtesy, not a contract */
      }
    }
  }

  function showPicker(variants, onPick) {
    hidePicker()
    if (!Array.isArray(variants) || variants.length === 0) return
    pickerPick = typeof onPick === 'function' ? onPick : null
    const menu = document.createElement('div')
    menu.className = 'moth-media-picker'
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', 'Choose which file to send to Moth')
    for (const variant of variants) {
      const item = document.createElement('button')
      item.type = 'button'
      item.setAttribute('role', 'menuitem')
      const label = document.createElement('span')
      label.className = 'moth-pick-label'
      label.textContent = variant.label || variant.url
      item.title = variant.url
      item.setAttribute('aria-label', `${label.textContent}${variant.isCurrent ? ', playing now' : ''}`)
      item.appendChild(label)
      const kind = document.createElement('span')
      kind.className = 'moth-pick-kind'
      kind.textContent = variant.kind || ''
      item.appendChild(kind)
      if (variant.isCurrent) {
        const now = document.createElement('span')
        now.className = 'moth-pick-now'
        now.textContent = '▶ playing'
        item.appendChild(now)
      }
      item.addEventListener('click', (event) => {
        event.stopPropagation()
        const pick = pickerPick
        hidePicker()
        if (pick) pick(variant)
      })
      menu.appendChild(item)
    }
    // Under the badge, clamped into the viewport; the menu scrolls past ~5 rows.
    const win = globalThis.window
    const width = (win && win.innerWidth) || 1024
    const height = (win && win.innerHeight) || 768
    const left = Math.max(8, Math.min(element.offsetLeft - 220, width - 310))
    const top = Math.min(element.offsetTop + 46, Math.max(8, height - 350))
    menu.style.left = `${Math.max(8, left)}px`
    menu.style.top = `${top}px`
    document.body.appendChild(menu)
    picker = menu
    try {
      document.addEventListener('pointerdown', onOutsidePicker, true)
      document.addEventListener('keydown', onPickerKey, true)
      const first = menu.querySelector('button')
      if (first) first.focus()
    } catch {
      /* listeners and focus are progressive enhancement */
    }
  }

  /** Muted refusal state (~1.5 s); the badge explains, then goes quiet. */
  function setRefusal(text) {
    element.classList.add('is-refused')
    element.classList.add('is-visible')
    element.setAttribute('aria-label', text)
    element.title = text
    if (refusalTimer) window.clearTimeout(refusalTimer)
    refusalTimer = window.setTimeout(() => {
      refusalTimer = 0
      element.classList.remove('is-refused')
      element.classList.remove('is-visible')
      element.setAttribute('aria-label', 'Send media to Moth')
      element.title = 'Send to Moth'
      lastRect = null
      lastAnchor = null
    }, REFUSAL_MS)
  }

  function onScroll() {
    // The stored rect is viewport-relative, so any scroll re-reads it.
    if (!lastRect) return
    try {
      if (lastAnchor && typeof lastAnchor.getBoundingClientRect === 'function') {
        lastRect = lastAnchor.getBoundingClientRect()
        place()
      } else {
        hide()
      }
    } catch {
      hide()
    }
  }

  function activate() {
    // A badge click with an open picker only dismisses it; the rows are the
    // action while it is up.
    if (picker) {
      hidePicker()
      return
    }
    if (typeof onActivate === 'function') onActivate()
  }

  element.addEventListener('click', (event) => {
    event.stopPropagation()
    activate()
  })
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      activate()
    }
  })
  window.addEventListener('scroll', onScroll, { capture: true, passive: true })

  let observer = null
  const Resize = globalThis.ResizeObserver
  if (typeof Resize === 'function') {
    observer = new Resize(() => onScroll())
    try {
      observer.observe(document.body)
    } catch {
      observer = null
    }
  }

  function destroy() {
    clearTimers()
    hidePicker()
    if (refusalTimer) window.clearTimeout(refusalTimer)
    window.removeEventListener('scroll', onScroll, { capture: true })
    if (observer) observer.disconnect()
    if (element.parentNode) element.parentNode.removeChild(element)
  }

  return { element, showAt, hide, destroy, setRefusal, showPicker, hidePicker }
}

root.MothBadge = { createBadge }
})(globalThis)
