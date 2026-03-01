const CURSOR_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M1 1L6 14L8 8L14 6L1 1Z" fill="currentColor" stroke="white" stroke-width="1" stroke-linejoin="round"/>
</svg>`

const DEFAULT_CURSOR_COLOR = '#3498db'

export function createCursorElement(color: string, userId: string): HTMLDivElement {
  const effectiveColor = color || DEFAULT_CURSOR_COLOR
  const el = document.createElement('div')
  el.className = 'multi-mouse-remote'
  el.setAttribute('data-user-id', userId)

  el.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
    z-index: 999999;
    will-change: transform;
    transition: transform 60ms ease-out, opacity 300ms ease;
    transform: translate(-100px, -100px);
    color: ${effectiveColor};
  `

  const svgContainer = document.createElement('div')
  svgContainer.innerHTML = CURSOR_SVG
  el.appendChild(svgContainer)

  const label = document.createElement('div')
  label.textContent = userId.slice(0, 4)
  label.style.cssText = `
    position: absolute;
    top: 16px;
    left: 10px;
    background: ${effectiveColor};
    color: white;
    font-size: 10px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 1px 4px;
    border-radius: 3px;
    white-space: nowrap;
    line-height: 1.4;
  `
  el.appendChild(label)

  document.body.appendChild(el)
  return el
}

export function removeCursorElement(el: HTMLDivElement) {
  el.remove()
}
