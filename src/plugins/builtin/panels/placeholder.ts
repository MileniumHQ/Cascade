import type { PanelContribution } from '@core/plugin-api'

/** Temporary panel body used until the real panel lands. */
export const placeholderPanel = (p: Omit<PanelContribution, 'mount'>): PanelContribution => ({
  ...p,
  mount(el) {
    el.innerHTML = `<div class="empty"><div class="empty-title">${p.title}</div><div class="empty-hint">Coming up</div></div>`
  }
})
