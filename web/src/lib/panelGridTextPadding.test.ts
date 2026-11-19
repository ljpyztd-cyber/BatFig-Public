import { describe, expect, it } from 'vitest'
import type { Manifest, ManifestElement } from './api'
import { flipY, type Rect4 } from './axesLayout'
import { effectiveOverride } from './effectiveOverride'
import { planPanelGridTextPadding, type PanelGridTextPaddingPlan } from './panelGridTextPadding'
import type { PanelObject, PanelOverride } from '@/types/document'

const panel = (extra: Partial<PanelObject> = {}): PanelObject => ({
  id: 'p', type: 'panel', fileId: 'p.pdf', fileKind: 'pdf', overrides: [],
  nativeW: 100, nativeH: 80, w: 100, h: 80, x: 0, y: 0, ...extra,
})
const axis = (gid = 'axes_0', position: Rect4 = [0.12, 0.12, 0.8, 0.75], extra: Partial<ManifestElement> = {}): ManifestElement => ({
  gid, role: 'axes', label: gid, draggable: true, resizable: true, bbox: flipY(position),
  editable: [{ prop: 'position', type: 'rect', value: position }, { prop: 'aspect', type: 'text', value: 'auto' }], ...extra,
})
const text = (gid: string, role: string, bbox: Rect4, extra: Partial<ManifestElement> = {}): ManifestElement => ({
  gid, role, label: gid, bbox, draggable: false, editable: [{ prop: 'fontsize', type: 'number', value: 12 }], ...extra,
})
const manifest = (...elements: ManifestElement[]): Manifest => ({ stem: 'padding', size_mm: [100, 80], elements })
const ready = (plan: PanelGridTextPaddingPlan) => {
  expect(plan.status).toBe('ready')
  if (plan.status !== 'ready') throw new Error(plan.message)
  return plan
}
const position = (overrides: PanelOverride[], gid = 'axes_0') => effectiveOverride(overrides, gid, 'position')!.value as Rect4

describe('measured axis text padding', () => {
  it('moves and uniformly shrinks the frame to contain negative y-label and lower x-label bounds', () => {
    const p = panel({ overrides: [{ gid: 'axes_0.xlabel', prop: 'fontsize', value: 12 }] })
    const m = manifest(axis(), text('axes_0.ylabel', 'axis_label', [-0.08, 0.21, 0.04, 0.5]),
      text('axes_0.xlabel', 'axis_label', [0.2, 0.98, 0.5, 0.08]))
    const original = structuredClone({ p, m })
    const plan = ready(planPanelGridTextPadding(p, m))
    expect(plan).toMatchObject({ changed: true, fits: false })
    const next = position(plan.overrides)
    expect(next[0]).toBeGreaterThan(0.2)
    expect(next[1]).toBeGreaterThan(0.18)
    expect(next[2] / next[3]).toBeCloseTo(0.8 / 0.75, 3)
    expect(next[2]).toBeLessThan(0.8)
    expect(plan.overrides[0]).toEqual(p.overrides[0])
    expect({ p, m }).toEqual(original)
  })

  it('uses final page scale for a 0.3 mm safety margin and ignores hidden overflow', () => {
    const m = manifest(axis(), text('axes_0.ylabel', 'axis_label', [-0.02, 0.25, 0.04, 0.4]),
      text('axes_0.title', 'title', [-2, -2, 4, 1], { editable: [{ prop: 'visible', type: 'bool', value: false }] }))
    const normal = position(ready(planPanelGridTextPadding(panel(), m)).overrides)
    const small = position(ready(planPanelGridTextPadding(panel({ w: 50, h: 40 }), m)).overrides)
    expect(normal[0]).toBe(0.143)
    expect(small[0]).toBe(0.146)
  })

  it('leaves fitting text unchanged and certifies only the supplied rendered bounds', () => {
    const p = panel()
    const m = manifest(axis(), text('axes_0.xlabel', 'axis_label', [0.2, 0.94, 0.5, 0.05]))
    expect(ready(planPanelGridTextPadding(p, m))).toEqual({ status: 'ready', overrides: p.overrides, changed: false, fits: true })
    expect(ready(planPanelGridTextPadding(panel({ rotation: 90 }), m)).fits).toBe(true)
  })

  it('treats a title above the figure as measured overflow', () => {
    const m = manifest(axis(), text('axes_0.title', 'title', [0.25, -0.04, 0.5, 0.08]))
    const next = flipY(position(ready(planPanelGridTextPadding(panel(), m)).overrides))
    expect(next[1]).toBeGreaterThan(0.17)
  })

  it('synchronizes twin axes and retains the right colorbar width and gap with its visible labels', () => {
    const frame: Rect4 = [0.2, 0.2, 0.6, 0.6]
    const bar: Rect4 = [0.85, 0.2, 0.03, 0.6]
    const m = manifest(axis('axes_0', frame, { follow_gids: ['axes_1', 'axes_2'] }),
      axis('axes_1', frame, { follow_gids: ['axes_0'] }),
      axis('axes_2', bar, { is_colorbar: true, colorbar_gid: 'axes_2.colorbar' }),
      { ...text('axes_2.colorbar', 'colorbar', flipY(bar)), geom_gid: 'axes_2', host_gid: 'axes_0',
        editable: [{ prop: 'orientation', type: 'enum', value: 'vertical' }] },
      text('axes_0.ylabel', 'axis_label', [-0.03, 0.3, 0.04, 0.4]),
      text('axes_2.ylabel', 'axis_label', [0.99, 0.25, 0.05, 0.5]))
    const plan = ready(planPanelGridTextPadding(panel(), m))
    const main = position(plan.overrides)
    const colorbar = position(plan.overrides, 'axes_2')
    expect(position(plan.overrides, 'axes_1')).toEqual(main)
    expect(colorbar[0] - main[0] - main[2]).toBeCloseTo(0.05, 4)
    expect(colorbar[2]).toBe(bar[2])
    expect(colorbar[1]).toBe(main[1])
    expect(colorbar[3]).toBe(main[3])
    expect(main[2] / main[3]).toBeCloseTo(1, 3)
  })

  it('moves a pinned outside top legend with the new plot center and top, preserving identity', () => {
    const p = panel({ overrides: [{ gid: 'axes_0.legend', prop: 'loc_frac', value: [0.25, 0.05], identity: 'l1:legend' }] })
    const m = manifest(axis(), text('axes_0.legend', 'legend', [0.25, -0.04, 0.5, 0.09]))
    const plan = ready(planPanelGridTextPadding(p, m))
    const next = flipY(position(plan.overrides))
    const moved = effectiveOverride(plan.overrides, 'axes_0.legend', 'loc_frac')!
    expect(moved.identity).toBe('l1:legend')
    expect((moved.value as number[])[1]).toBeCloseTo(0.05 + next[1] - 0.13, 4)
  })

  it('rejects text bigger than the figure, explicit clipping and pinned axis labels', () => {
    const huge = manifest(axis(), text('axes_0.xlabel', 'axis_label', [-0.1, 0.9, 1.2, 0.08]))
    expect(planPanelGridTextPadding(panel(), huge)).toMatchObject({ status: 'error' })
    const clipped = manifest(axis(), text('axes_0.xlabel', 'axis_label', [0.2, 0.96, 0.5, 0.08], { clip_bbox: [0, 0, 1, 1] }))
    expect(planPanelGridTextPadding(panel(), clipped)).toMatchObject({ status: 'error' })
    const pinned = panel({ overrides: [{ gid: 'axes_0.ylabel', prop: 'pos_frac', value: [-0.1, 0.5] }] })
    expect(planPanelGridTextPadding(pinned, manifest(axis(), text('axes_0.ylabel', 'axis_label', [-0.12, 0.2, 0.04, 0.5]))))
      .toMatchObject({ status: 'error' })
  })

  it.each([
    { rotation: 90 as const }, { crop: { x: 0.1, y: 0, w: 0.9, h: 1 } }, { flipH: true }, { locked: true },
  ])('refuses clipping repairs for unsupported transformed/locked panels: %j', (extra) => {
    expect(planPanelGridTextPadding(panel(extra), manifest(axis(), text('axes_0.ylabel', 'axis_label', [-0.1, 0.2, 0.04, 0.4]))))
      .toMatchObject({ status: 'error' })
  })

  it('refuses fixed-aspect and unrelated multiple frames with clipping', () => {
    const label = text('axes_0.ylabel', 'axis_label', [-0.1, 0.2, 0.04, 0.4])
    const fixed = axis()
    fixed.editable[1].value = 'equal'
    expect(planPanelGridTextPadding(panel(), manifest(fixed, label))).toMatchObject({ status: 'error' })
    expect(planPanelGridTextPadding(panel(), manifest(axis(), axis('axes_1'), label))).toMatchObject({ status: 'error' })
  })
})
