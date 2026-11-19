import type { Manifest } from './api'
import { isElementHidden } from './elementGeom'
import { effectiveOverride, upsertOverrides } from './effectiveOverride'
import { pagePtLens } from './stylePresets'
import { coerceTypography, propertyPathOf } from './typography'
import { panelFullSize, type PanelObject, type PanelOverride } from '@/types/document'

export interface PanelGridTypographyTarget {
  gid: string
  prop: string
  scriptSizePt: number
}

export type PanelGridTypographyPlan = {
  status: 'ready'
  overrides: PanelOverride[]
  changed: boolean
  targets: PanelGridTypographyTarget[]
} | {
  status: 'error'
  code: 'font_size_invalid' | 'font_size_unsupported'
  message: string
}

const failure = (code: 'font_size_invalid' | 'font_size_unsupported', message: string): PanelGridTypographyPlan =>
  ({ status: 'error', code, message })

/**
 * Equalize the visible plotting axes' typography at the final canvas size.
 * The caller supplies this variant's exact manifest and commits/renders the
 * complete result atomically. Colorbars and other text retain their own style.
 */
export function planPanelGridTypography(panel: PanelObject, manifest: Manifest, pageSizePt: number): PanelGridTypographyPlan {
  const requested = coerceTypography('sizePt', pageSizePt)
  if (typeof pageSizePt !== 'number' || !requested.ok) {
    return failure('font_size_invalid', 'Axis font size must be a finite, supported page-point value')
  }
  const axes = manifest.elements.filter((el) =>
    (el.role === 'axes' || el.role === 'axes3d') && !el.is_colorbar && !isElementHidden(el))
  const elements = manifest.elements.filter((el) =>
    (el.role === 'ticks' || el.role === 'axis_label') && !isElementHidden(el) &&
    axes.some((axis) => el.gid.startsWith(`${axis.gid}.`)))
  if (!elements.length) return { status: 'ready', overrides: panel.overrides, changed: false, targets: [] }

  const full = panelFullSize(panel)
  if (![full.w, full.h, panel.nativeW, panel.nativeH].every((value) => Number.isFinite(value) && value > 0)) {
    return failure('font_size_unsupported', 'The panel has no valid physical font scale')
  }
  const prop = propertyPathOf('figureText', 'sizePt')
  if (!prop) return failure('font_size_unsupported', 'Figure text has no font-size property')
  const lens = pagePtLens(panel)
  const targets: PanelGridTypographyTarget[] = []
  const patches: PanelOverride[] = []
  const locked = new Set(panel.lockedGids ?? [])
  for (const el of elements) {
    const axis = axes.find((candidate) => el.gid.startsWith(`${candidate.gid}.`))!
    const lockedTick = el.role === 'ticks' && [...locked].some((gid) =>
      gid.startsWith(el.gid.replace(/ticks$/, 'ticklabels_')))
    if (panel.locked || locked.has('figure') || locked.has(axis.gid) || locked.has(el.gid) || lockedTick) {
      return failure('font_size_unsupported', `Axis typography is locked: ${el.gid}`)
    }
    const field = el.editable.find((entry) => entry.prop === prop)
    if (!field || field.type !== 'number') {
      return failure('font_size_unsupported', `Axis font size is not editable: ${el.gid}`)
    }
    const checked = coerceTypography('sizePt', pageSizePt, lens.field(field))
    if (!checked.ok) {
      return failure('font_size_unsupported', `Page font size is outside the supported range: ${el.gid}`)
    }
    const scriptSizePt = lens.toScript(prop, checked.value)
    if (typeof scriptSizePt !== 'number' || !coerceTypography('sizePt', scriptSizePt, field).ok) {
      return failure('font_size_unsupported', `Converted font size is outside the supported range: ${el.gid}`)
    }
    targets.push({ gid: el.gid, prop, scriptSizePt })
    const existing = effectiveOverride(panel.overrides, el.gid, prop)
    const current = existing?.value ?? field.value
    // The source tick size does not certify its scientific-notation offset.
    // An explicit group setter normalizes both; an existing matching override
    // already carries that intent and remains a no-op on repeat application.
    if (current !== scriptSizePt || (el.role === 'ticks' && !existing)) {
      patches.push({ gid: el.gid, prop, value: scriptSizePt })
    }
  }
  if (!patches.length) return { status: 'ready', overrides: panel.overrides, changed: false, targets }
  const overrides = [...panel.overrides]
  upsertOverrides({ overrides }, patches)
  return { status: 'ready', overrides, changed: true, targets }
}
