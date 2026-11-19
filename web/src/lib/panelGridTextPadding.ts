import type { Manifest, ManifestElement } from './api'
import { flipY, round4, sameAfterRound4, unionBox, type Rect4 } from './axesLayout'
import { isElementHidden, positionOf } from './elementGeom'
import { effectiveOverride, isEffectiveOverrideAt, upsertOverrides } from './effectiveOverride'
import { planPlotFrame } from './plotFrameLayout'
import { panelFullSize, type PanelObject, type PanelOverride } from '@/types/document'

export type PanelGridTextPaddingPlan = {
  status: 'ready'
  overrides: PanelOverride[]
  changed: boolean
  /** Only the supplied rendered geometry can certify fit; changed candidates need another render. */
  fits: boolean
} | { status: 'error'; message: string }

const EPS = 1e-4
const TEXT_ROLES = new Set(['axis_label', 'ticks', 'ticklabel', 'title', 'legend', 'legend_text'])
const valid = (box: readonly number[] | null): box is Rect4 =>
  !!box && box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0
const right = (box: Rect4) => box[0] + box[2]
const bottom = (box: Rect4) => box[1] + box[3]
const outside = (box: Rect4) => box[0] < -EPS || box[1] < -EPS || right(box) > 1 + EPS || bottom(box) > 1 + EPS
const under = (el: ManifestElement, axes: readonly ManifestElement[]) => axes.some((axis) => el.gid.startsWith(`${axis.gid}.`))
const field = (el: ManifestElement, prop: string) => el.editable.find((entry) => entry.prop === prop)?.value
const failure = (message: string): PanelGridTextPaddingPlan => ({ status: 'error', message })

/**
 * Reserve room for measured text without changing its point size or the plot's
 * current physical aspect. Ordinary 2D plots, their twin axes, right colorbars
 * and top legends are supported. Never infer missing geometry or wrap text.
 */
export function planPanelGridTextPadding(panel: PanelObject, manifest: Manifest): PanelGridTextPaddingPlan {
  const unchanged = (): PanelGridTextPaddingPlan => ({ status: 'ready', overrides: panel.overrides, changed: false, fits: true })
  const axes = manifest.elements.filter((el) => (el.role === 'axes' || el.role === 'axes3d') && !isElementHidden(el))
  const main = axes.filter((el) => !el.is_colorbar)
  const texts = manifest.elements.filter((el) => !isElementHidden(el) && under(el, axes) &&
    (TEXT_ROLES.has(el.role) || (el.role === 'text' && under(el, axes.filter((axis) => axis.is_colorbar)))))
  if (!texts.length) return unchanged()
  if (texts.some((el) => !valid(el.bbox))) return failure('Visible axis text has no finite layout bounds')
  if (!texts.some((el) => outside(el.bbox))) return unchanged()
  if (!main.length || !valid(main[0].bbox)) return failure('Clipped text has no supported plotting frame')
  const full = panelFullSize(panel)
  if (![full.w, full.h, panel.nativeW, panel.nativeH].every((value) => Number.isFinite(value) && value > 0)) {
    return failure('Clipped text has no valid physical figure dimensions')
  }
  const old = main[0].bbox
  const ratio = old[2] * panel.nativeW / (old[3] * panel.nativeH)
  const supported = planPlotFrame(panel, manifest, ratio)
  if (supported.status !== 'ready') return failure(`Clipped text cannot be padded for this plot: ${supported.reason}`)
  const padX = 0.3 / full.w
  const padY = 0.3 / full.h
  if (texts.some((el) => el.role !== 'ticks' && (el.bbox[2] > 1 - 2 * padX || el.bbox[3] > 1 - 2 * padY))) {
    return failure('Text itself is larger than the figure; use a smaller font or a larger figure')
  }
  if (texts.some((el) => valid(el.clip_bbox ?? null) &&
    (el.bbox[0] < el.clip_bbox![0] - EPS || el.bbox[1] < el.clip_bbox![1] - EPS ||
      right(el.bbox) > el.clip_bbox![0] + el.clip_bbox![2] + EPS || bottom(el.bbox) > el.clip_bbox![1] + el.clip_bbox![3] + EPS))) {
    return failure('Explicitly clipped text cannot be repaired by changing plot margins')
  }
  if (panel.overrides.some((override, index) => isEffectiveOverrideAt(panel.overrides, index) &&
    ['pos_frac', 'endpoints_frac'].includes(override.prop) && axes.some((axis) => override.gid.startsWith(`${axis.gid}.`)))) {
    return failure('Manually positioned annotations prevent automatic text padding')
  }
  const envelope = unionBox([old, ...texts.map((el) => el.bbox), ...axes.filter((el) => el.is_colorbar).map((el) => el.bbox)])!
  const left = Math.max(0, old[0] - envelope[0]) + padX
  const top = Math.max(0, old[1] - envelope[1]) + padY
  const rightPad = Math.max(0, right(envelope) - right(old)) + padX
  const bottomPad = Math.max(0, bottom(envelope) - bottom(old)) + padY
  const availableW = 1 - left - rightPad
  const availableH = 1 - top - bottomPad
  if (availableW <= EPS || availableH <= EPS) return failure('Axis text leaves no room for the plotting frame')
  const scale = Math.min(1, availableW / old[2], availableH / old[3])
  const width = old[2] * scale
  const height = old[3] * scale
  if (width < EPS || height < EPS) return failure('Axis text leaves no usable plotting frame')
  const newLeft = Math.min(Math.max(old[0], left), 1 - rightPad - width)
  const newTop = Math.min(Math.max(old[1], top), 1 - bottomPad - height)
  const position = flipY([newLeft, newTop, width, height]).map(round4) as Rect4
  const after = flipY(position)
  if (sameAfterRound4(old, after)) return failure('Text padding cannot resolve the remaining overflow')
  const patches: PanelOverride[] = []
  const put = (el: ManifestElement, prop: string, value: readonly number[], before: readonly number[]) => {
    const rounded = value.map(round4)
    if (!sameAfterRound4(before, rounded)) patches.push({ gid: el.gid, prop, value: rounded })
  }
  for (const axis of main) put(axis, 'position', position, positionOf(panel, axis)!)
  for (const axis of axes.filter((el) => el.is_colorbar)) {
    const semantic = manifest.elements.find((el) => el.role === 'colorbar' &&
      (el.geom_gid === axis.gid || el.gid === axis.colorbar_gid))
    const prior = positionOf(panel, axis)
    if (!semantic || !main.some((el) => el.gid === semantic.host_gid) ||
      field(semantic, 'orientation') !== 'vertical' || !axis.resizable || !valid(prior)) {
      return failure('Clipped text has an unsupported colorbar placement')
    }
    const gap = prior[0] - right(old)
    if (gap < -EPS) return failure('Only right-side colorbars support automatic text padding')
    const sy = position[3] / old[3]
    put(axis, 'position', [position[0] + position[2] + gap,
      position[1] + (prior[1] - (1 - bottom(old))) * sy, prior[2], prior[3] * sy], prior)
  }
  for (const legend of texts.filter((el) => el.role === 'legend')) {
    const custom = effectiveOverride(panel.overrides, legend.gid, 'loc_frac')
    if (!custom) {
      if (legend.unsupported_props?.some((prop) => prop.prop === 'loc_anchor')) return failure('Legend has an unsupported anchor transform')
      continue
    }
    if (!under(legend, main) || !Array.isArray(custom.value) || custom.value.length !== 2 ||
      !custom.value.every((value) => typeof value === 'number' && Number.isFinite(value)) || bottom(legend.bbox) > old[1] + EPS) {
      return failure('Only top legends support manually anchored text padding')
    }
    put(legend, 'loc_frac', [custom.value[0] + after[0] + after[2] / 2 - old[0] - old[2] / 2,
      custom.value[1] + after[1] - old[1]], custom.value)
  }
  const overrides = [...panel.overrides]
  upsertOverrides({ overrides }, patches)
  return { status: 'ready', overrides, changed: true, fits: false }
}
