import { iconMarkup } from './icon'

/** A small pill (icon + label) as the drag image for dragging a source out of a panel. */
export function setDragImage(e: DragEvent, icon: string, label: string, color: string) {
  const pill = document.createElement('div')
  pill.className = 'ui-dragimg'
  pill.style.setProperty('--tc', color)
  pill.innerHTML = `<span class="ui-dragimg-icon">${iconMarkup(icon, 2.2)}</span><span class="ui-dragimg-label"></span>`
  pill.querySelector('.ui-dragimg-label')!.textContent = label
  document.body.appendChild(pill)
  e.dataTransfer?.setDragImage(pill, 14, 14)
  setTimeout(() => pill.remove(), 0)
}
