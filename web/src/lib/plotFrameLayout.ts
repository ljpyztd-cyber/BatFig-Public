import type { Manifest, ManifestElement } from './api'
import { flipY, round4, sameAfterRound4, type Rect4 } from './axesLayout'
import { panelAxesBounds } from './canvasAlignment'
import { isElementHidden, positionOf } from './elementGeom'
import { effectiveOverride, isEffectiveOverrideAt, upsertOverrides } from './effectiveOverride'
import type { Rect } from './geometry'
import { panelRotation, type PanelObject, type PanelOverride } from '@/types/document'

export interface PlotFramePlan {
  status: 'ready' | 'preserve'
  /** Complete override list, in its original order, including untouched edits. */
  overrides: PanelOverride[]
  /** Predicted plotting frame in page mm, not the enclosing source figure. */
  bounds: Rect | null
  changed: boolean
  reason?: string
}

const validBox = (box: readonly number[] | null): box is Rect4 =>
  !!box && box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0
const field = (el: ManifestElement, prop: string) => el.editable.find((entry) => entry.prop === prop)?.value
const under = (gid: string, axes: readonly ManifestElement[]) => axes.some((axis) => gid.startsWith(`${axis.gid}.`))
const EPS = 1e-4

/**
 * Re-layout a single ordinary 2D plotting frame before whole-figure grid scaling.
 * The caller must supply this variant's exact manifest and verify the rendered
 * candidate before committing. Fonts, data, aspect and source figure size stay
 * untouched. Unsupported scientific geometry is retained as a complete figure.
 */
export function planPlotFrame(panel: PanelObject, manifest: Manifest, ratio: number): PlotFramePlan {
  const current = panelAxesBounds(panel, manifest)
  const preserve = (reason: string): PlotFramePlan => ({
    status: 'preserve', overrides: panel.overrides, bounds: current, changed: false, reason,
  })
  if (![ratio, panel.nativeW, panel.nativeH, panel.w, panel.h].every((value) => Number.isFinite(value) && value > 0)) return preserve('invalid_geometry')
  if (panel.locked || panel.layoutPinned || panel.lockedGids?.length) return preserve('locked')
  if (panelRotation(panel) || panel.flipH || panel.flipV ||
    (panel.crop && !sameAfterRound4([panel.crop.x, panel.crop.y, panel.crop.w, panel.crop.h], [0, 0, 1, 1]))) return preserve('transformed_panel')

  const axes = manifest.elements.filter((el) => (el.role === 'axes' || el.role === 'axes3d') && !isElementHidden(el))
  const main = axes.filter((el) => !el.is_colorbar)
  if (!main.length) return preserve('no_plot_axes')
  if (main.some((el) => el.role !== 'axes')) return preserve('three_dimensional')
  // Missing aspect is unknown, never an invitation to override a scientific ratio.
  if (main.some((el) => field(el, 'aspect') !== 'auto')) return preserve('fixed_aspect')
  if (main.some((el) => !el.resizable || !validBox(positionOf(panel, el)) || !validBox(el.bbox))) return preserve('unsupported_position')
  const before = main[0].bbox
  if (main.some((el) => !sameAfterRound4(el.bbox, before))) return preserve('multiple_plot_frames')
  // Coincidence alone cannot establish twin axes; the engine owns that relation.
  const linked = new Set([main[0].gid])
  for (let pass = 0; pass < main.length; pass++) {
    for (const axis of main) {
      if (linked.has(axis.gid) || main.some((other) => linked.has(other.gid) &&
        ((other.follow_gids ?? []).includes(axis.gid) || (axis.follow_gids ?? []).includes(other.gid)))) linked.add(axis.gid)
    }
  }
  if (linked.size !== main.length) return preserve('unrelated_plot_axes')
  // A box-aspect/locator may constrain an otherwise auto-aspect axes. The actual
  // box must agree with its writable position before a predicted box is credible.
  if (main.some((el) => flipY(positionOf(panel, el)!).some((value, index) => Math.abs(value - el.bbox[index]) > EPS * 1.1))) return preserve('constrained_position')

  let width = before[2]
  let height = before[3]
  if (width * panel.nativeW > height * panel.nativeH * ratio) width = height * panel.nativeH * ratio / panel.nativeW
  else height = width * panel.nativeW / (ratio * panel.nativeH)
  // Left/bottom stay fixed. Quantization is the same as all other axes writers.
  const position = [before[0], 1 - before[1] - before[3], width, height].map(round4) as Rect4
  if (!validBox(position)) return preserve('invalid_geometry')
  const after = flipY(position)
  const bounds = { x: panel.x + after[0] * panel.w, y: panel.y + after[1] * panel.h, w: after[2] * panel.w, h: after[3] * panel.h }
  if (sameAfterRound4(before, after)) return { status: 'ready', overrides: panel.overrides, bounds: current, changed: false }
  const patches: PanelOverride[] = []
  const put = (el: ManifestElement, prop: string, value: number[], baseline: readonly number[]) => {
    const rounded = value.map(round4)
    if (!sameAfterRound4(rounded, baseline)) patches.push({ gid: el.gid, prop, value: rounded })
  }
  for (const axis of main) put(axis, 'position', position, positionOf(panel, axis)!)

  for (const axis of axes.filter((el) => el.is_colorbar)) {
    const semantic = manifest.elements.find((el) => el.role === 'colorbar' &&
      (el.geom_gid === axis.gid || el.gid === axis.colorbar_gid))
    if (!semantic || !main.some((el) => el.gid === semantic.host_gid)) return preserve('unbound_colorbar')
    if (field(semantic, 'orientation') !== 'vertical') return preserve('horizontal_colorbar')
    const old = positionOf(panel, axis)
    if (!axis.resizable || !validBox(old)) return preserve('unsupported_colorbar_position')
    const gap = old[0] - before[0] - before[2]
    if (gap < -EPS) return preserve('non_right_colorbar')
    const scaleY = position[3] / before[3]
    const oldBottom = 1 - before[1] - before[3]
    put(axis, 'position', [position[0] + position[2] + gap,
      position[1] + (old[1] - oldBottom) * scaleY, old[2], old[3] * scaleY], old)
  }

  for (const el of manifest.elements.filter((entry) => entry.role === 'legend' && !isElementHidden(entry))) {
    const custom = effectiveOverride(panel.overrides, el.gid, 'loc_frac')
    if (!custom) {
      // Matplotlib's normal axes-relative loc/bbox_to_anchor follows the new
      // frame. A custom parent transform cannot make the same promise.
      if (under(el.gid, main) && el.unsupported_props?.some((prop) => prop.prop === 'loc_anchor')) return preserve('unsupported_legend_anchor')
      continue
    }
    if (!under(el.gid, main) || !Array.isArray(custom.value) || custom.value.length !== 2 ||
      !custom.value.every((value) => typeof value === 'number' && Number.isFinite(value)) ||
      el.bbox[1] + el.bbox[3] > before[1] + EPS) return preserve('custom_legend_position')
    // loc_frac anchors the legend's lower-left in top-origin figure fractions.
    // Move its centre with the plot centre; keep the existing vertical clearance.
    put(el, 'loc_frac', [custom.value[0] + (after[0] + after[2] / 2) - (before[0] + before[2] / 2),
      custom.value[1] + after[1] - before[1]], custom.value as number[])
  }
  // Manually pinned labels/annotations would otherwise be left behind when axes
  // reflow. They need a separate explicit semantic placement policy.
  if (panel.overrides.some((override, index) => isEffectiveOverrideAt(panel.overrides, index) &&
    ['pos_frac', 'endpoints_frac'].includes(override.prop) && under(override.gid, axes))) return preserve('custom_annotation_position')

  const overrides = [...panel.overrides]
  upsertOverrides({ overrides }, patches)
  return { status: 'ready', overrides, bounds, changed: patches.length > 0 }
}
