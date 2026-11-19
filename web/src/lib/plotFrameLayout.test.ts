import { describe, expect, it } from 'vitest'
import type { Manifest, ManifestElement } from './api'
import { flipY, type Rect4 } from './axesLayout'
import { effectiveOverride } from './effectiveOverride'
import { planPlotFrame } from './plotFrameLayout'
import type { PanelObject, PanelOverride } from '@/types/document'

const panel = (overrides: PanelOverride[] = []): PanelObject => ({
  id: 'p', type: 'panel', fileId: 'p.pdf', fileKind: 'pdf', script: 'p.py',
  x: 10, y: 20, w: 95.25, h: 76.2, nativeW: 95.25, nativeH: 76.2, overrides,
})
const axis = (gid: string, position: Rect4, extra: Partial<ManifestElement> = {}): ManifestElement => ({
  gid, role: 'axes', label: gid, bbox: flipY(position), resizable: true, draggable: true,
  editable: [{ prop: 'position', type: 'rect', value: position }, { prop: 'aspect', type: 'text', value: 'auto' }],
  ...extra,
})
const manifest = (elements: ManifestElement[]): Manifest => ({ stem: 'plot-frame', size_mm: [95.25, 76.2], elements })
const pos = (overrides: PanelOverride[], gid: string) => effectiveOverride(overrides, gid, 'position')?.value as Rect4
const appliedManifest = (source: Manifest, overrides: PanelOverride[]): Manifest => ({ ...source, elements: source.elements.map((el) => {
  const position = pos(overrides, el.gid)
  return position ? { ...el, bbox: flipY(position), editable: el.editable.map((entry) => entry.prop === 'position' ? { ...entry, value: position } : entry) } : el
}) })
const withColorbar = (position: Rect4, bar: Rect4, orientation = 'vertical') => manifest([
  axis('axes_0', position, { follow_gids: ['axes_1'] }),
  axis('axes_1', bar, { is_colorbar: true, colorbar_gid: 'axes_1.colorbar' }),
  { gid: 'axes_1.colorbar', role: 'colorbar', label: 'scale', bbox: flipY(bar), draggable: true,
    geom_gid: 'axes_1', host_gid: 'axes_0', editable: [{ prop: 'orientation', type: 'enum', value: orientation, options: ['vertical', 'horizontal'] }] },
])

describe('plot frame layout', () => {
  it.each([
    ['d', [0.17, 0.19, 0.57, 0.74]],
    ['g', [0.19, 0.25, 0.79, 0.70]],
    ['f', [0.17, 0.23, 0.80, 0.64]],
  ] as [string, Rect4][])('re-layouts %s to the common physical ratio while retaining left/bottom and all styles/data', (_name, original) => {
    // Geometry-only examples of heatmap, bar and stacked-bar layouts.
    const untouched: PanelOverride[] = [
      { gid: 'axes_0.xlabel', prop: 'fontfamily', value: 'Arial', identity: 'l1:font' },
      { gid: 'axes_0', prop: 'xlim', value: [950, 780] },
      { gid: 'axes_0.collections_0', prop: 'cmap', value: 'viridis' },
    ]
    const p = panel(untouched)
    const m = manifest([axis('axes_0', original)])
    const before = structuredClone({ p, m })
    const plan = planPlotFrame(p, m, 4 / 3)
    expect(plan.status).toBe('ready')
    expect(plan.changed).toBe(true)
    const next = pos(plan.overrides, 'axes_0')
    expect(next[0]).toBe(original[0])
    expect(next[1]).toBe(original[1])
    expect(next[2]).toBeLessThanOrEqual(original[2])
    expect(next[3]).toBeLessThanOrEqual(original[3])
    expect(next[2] * p.nativeW / (next[3] * p.nativeH)).toBeCloseTo(4 / 3, 3)
    expect(plan.bounds!.x).toBeCloseTo(p.x + original[0] * p.w)
    expect(plan.bounds!.y + plan.bounds!.h).toBeCloseTo(p.y + (1 - original[1]) * p.h)
    expect(plan.overrides.slice(0, 3)).toEqual(untouched)
    expect(plan.overrides.slice(3).map((entry) => entry.prop)).toEqual(['position'])
    expect({ p, m }).toEqual(before)
  })

  it('keeps the right vertical colorbar width/gap and scales its height with the host', () => {
    const p = panel()
    const m = withColorbar([0.17, 0.19, 0.57, 0.74], [0.78, 0.19, 0.035, 0.74])
    const plan = planPlotFrame(p, m, 4 / 3)
    expect(plan.status).toBe('ready')
    const plot = pos(plan.overrides, 'axes_0')
    const bar = pos(plan.overrides, 'axes_1')
    expect(bar[0] - plot[0] - plot[2]).toBeCloseTo(0.04, 4)
    expect(bar[1]).toBe(plot[1])
    expect(bar[2]).toBe(0.035)
    expect(bar[3]).toBe(plot[3])
    expect(bar[3]).toBeLessThan(0.74)
  })

  it('moves a right colorbar when the main frame becomes narrower, preserving an intentionally shorter bar', () => {
    const m = withColorbar([0.1, 0.2, 0.7, 0.6], [0.85, 0.25, 0.03, 0.5])
    const plan = planPlotFrame(panel(), m, 1)
    const plot = pos(plan.overrides, 'axes_0')
    const bar = pos(plan.overrides, 'axes_1')
    expect(bar).toEqual([0.63, 0.25, 0.03, 0.5])
    expect(bar[0] - plot[0] - plot[2]).toBeCloseTo(0.05, 4)
  })

  it('retains an ordinary axes-relative top legend and moves only an explicitly pinned top legend', () => {
    const topLegend: ManifestElement = { gid: 'axes_0.legend', role: 'legend', label: 'SSIP CIP AGG', bbox: [0.28, 0.02, 0.36, 0.05],
      draggable: true, drag_prop: 'loc_frac', anchor: [0.28, 0.07], editable: [] }
    const m = manifest([axis('axes_0', [0.17, 0.23, 0.8, 0.64]), topLegend])
    const automatic = planPlotFrame(panel(), m, 4 / 3)
    expect(automatic.overrides.map((entry) => entry.gid)).toEqual(['axes_0'])
    const pinned = planPlotFrame(panel([{ gid: topLegend.gid, prop: 'loc_frac', value: topLegend.anchor, identity: 'l1:legend' }]), m, 4 / 3)
    const moved = effectiveOverride(pinned.overrides, topLegend.gid, 'loc_frac')!
    expect(moved.identity).toBe('l1:legend')
    expect((moved.value as number[])[0]).toBeCloseTo(0.22135, 3)
    expect((moved.value as number[])[1]).toBe(0.07)
    const tall = manifest([axis('axes_0', [0.17, 0.19, 0.57, 0.74]), topLegend])
    const raised = planPlotFrame(panel([{ gid: topLegend.gid, prop: 'loc_frac', value: topLegend.anchor }]), tall, 4 / 3)
    const newTop = 1 - pos(raised.overrides, 'axes_0')[1] - pos(raised.overrides, 'axes_0')[3]
    const anchor = effectiveOverride(raised.overrides, topLegend.gid, 'loc_frac')!.value as number[]
    expect(newTop - anchor[1]).toBeCloseTo(0.07 - 0.07, 4)
  })

  it('preserves effective override position and identity without reordering duplicate history entries', () => {
    const old: Rect4 = [0.1, 0.2, 0.7, 0.6]
    const p = panel([
      { gid: 'axes_0', prop: 'position', value: [0.2, 0.3, 0.4, 0.5], identity: 'l1:old' },
      { gid: 'axes_0.title', prop: 'fontsize', value: 20 },
      { gid: 'axes_0', prop: 'position', value: old, identity: 'l1:current' },
    ])
    const plan = planPlotFrame(p, manifest([axis('axes_0', old)]), 1)
    expect(plan.overrides).toHaveLength(3)
    expect(plan.overrides[0]).toBe(p.overrides[0])
    expect(plan.overrides[1]).toBe(p.overrides[1])
    expect(plan.overrides[2]).toEqual({ gid: 'axes_0', prop: 'position', value: [0.1, 0.2, 0.48, 0.6], identity: 'l1:current' })
    const replay = planPlotFrame({ ...p, overrides: plan.overrides }, appliedManifest(manifest([axis('axes_0', old)]), plan.overrides), 1)
    expect(replay.changed).toBe(false)
    expect(replay.overrides).toBe(plan.overrides)
  })

  it('writes all confirmed coincident twins, and declines overlapping unrelated axes', () => {
    const a = axis('axes_0', [0.1, 0.2, 0.7, 0.6], { follow_gids: ['axes_1'] })
    const b = axis('axes_1', [0.1, 0.2, 0.7, 0.6])
    const plan = planPlotFrame(panel(), manifest([a, b]), 1)
    expect(plan.status).toBe('ready')
    expect(pos(plan.overrides, 'axes_0')).toEqual(pos(plan.overrides, 'axes_1'))
    expect(planPlotFrame(panel(), manifest([{ ...a, follow_gids: [] }, b]), 1).reason).toBe('unrelated_plot_axes')
  })

  it.each(['equal', '1', undefined])('preserves fixed/unknown aspect %s including pie-style axes', (aspect) => {
    const a = axis('axes_0', [0.1, 0.2, 0.7, 0.6])
    a.editable = a.editable.filter((entry) => entry.prop !== 'aspect')
    if (aspect) a.editable.push({ prop: 'aspect', type: 'text', value: aspect })
    const p = panel([{ gid: 'axes_0.title', prop: 'fontsize', value: 20 }])
    expect(planPlotFrame(p, manifest([a]), 1)).toMatchObject({ status: 'preserve', overrides: p.overrides, changed: false, reason: 'fixed_aspect' })
  })

  it('preserves 3D, multiple subplots, transformed panels, element locks and constrained positions', () => {
    const p = panel()
    const a = axis('axes_0', [0.1, 0.2, 0.7, 0.6])
    const m = manifest([a])
    expect(planPlotFrame(p, manifest([{ ...a, role: 'axes3d' }]), 1).reason).toBe('three_dimensional')
    expect(planPlotFrame(p, manifest([a, axis('axes_1', [0.6, 0.2, 0.3, 0.6])]), 1).reason).toBe('multiple_plot_frames')
    for (const transform of [{ crop: { x: 0.1, y: 0, w: 0.9, h: 1 } }, { rotation: 90 as const }, { flipH: true }, { flipV: true }]) {
      expect(planPlotFrame({ ...p, ...transform }, m, 1).reason).toBe('transformed_panel')
    }
    expect(planPlotFrame({ ...p, lockedGids: ['axes_0.xlabel'] }, m, 1).reason).toBe('locked')
    expect(planPlotFrame(p, manifest([{ ...a, bbox: [0.2, 0.2, 0.5, 0.6] }]), 1).reason).toBe('constrained_position')
  })

  it('declines horizontal/unbound/left colorbars and hand-positioned labels instead of partially changing a figure', () => {
    const p = panel()
    expect(planPlotFrame(p, withColorbar([0.1, 0.2, 0.7, 0.6], [0.1, 0.05, 0.7, 0.03], 'horizontal'), 1).reason).toBe('horizontal_colorbar')
    const m = withColorbar([0.1, 0.2, 0.7, 0.6], [0.03, 0.2, 0.03, 0.6])
    expect(planPlotFrame(p, m, 1).reason).toBe('non_right_colorbar')
    expect(planPlotFrame(p, { ...m, elements: m.elements.slice(0, 2) }, 1).reason).toBe('unbound_colorbar')
    const pinned = panel([{ gid: 'axes_0.xlabel', prop: 'pos_frac', value: [0.5, 0.9] }])
    const plan = planPlotFrame(pinned, manifest([axis('axes_0', [0.1, 0.2, 0.7, 0.6])]), 1)
    expect(plan).toMatchObject({ status: 'preserve', changed: false, reason: 'custom_annotation_position' })
    expect(plan.overrides).toBe(pinned.overrides)
  })
})
