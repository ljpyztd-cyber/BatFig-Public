import { describe, expect, it } from 'vitest'
import type { EditableField, Manifest, ManifestElement } from './api'
import { effectiveOverride } from './effectiveOverride'
import { planPanelGridTypography, type PanelGridTypographyPlan } from './panelGridTypography'
import type { PanelObject } from '@/types/document'

const panel = (scale = 1, extra: Partial<PanelObject> = {}): PanelObject => ({
  id: 'a', type: 'panel', fileId: 'a.pdf', fileKind: 'pdf', overrides: [],
  nativeW: 100, nativeH: 80, x: 0, y: 0, w: 100 * scale, h: 80 * scale, ...extra,
})
const size = (value = 9, extra: Partial<EditableField> = {}): EditableField => ({
  prop: 'fontsize', type: 'number', value, min: 3, max: 24, ...extra,
})
const element = (gid: string, role: string, editable: EditableField[] = [], extra: Partial<ManifestElement> = {}): ManifestElement => ({
  gid, role, label: gid, editable, bbox: [0.1, 0.1, 0.7, 0.7], draggable: false, ...extra,
})
const manifest = (elements: ManifestElement[] = [
  element('axes_0', 'axes'),
  element('axes_0.xticks', 'ticks', [size()]),
  element('axes_0.yticks', 'ticks', [size()]),
  element('axes_0.xlabel', 'axis_label', [size(10, { max: 36 })]),
  element('axes_0.ylabel', 'axis_label', [size(10, { max: 36 })]),
]): Manifest => ({ stem: 'typography', size_mm: [100, 80], elements })
const ready = (plan: PanelGridTypographyPlan) => {
  expect(plan.status).toBe('ready')
  if (plan.status !== 'ready') throw new Error(plan.message)
  return plan
}

describe('grid axis typography in physical page points', () => {
  it('gives differently scaled panels the same 12 pt axis titles and tick numbers', () => {
    for (const scale of [0.5, 0.75, 1, 1.5]) {
      const plan = ready(planPanelGridTypography(panel(scale), manifest(), 12))
      expect(plan.targets).toHaveLength(4)
      for (const target of plan.targets) {
        // Independently measure the exported page size, not the script value.
        expect(target.scriptSizePt * scale).toBeCloseTo(12, 2)
        expect(effectiveOverride(plan.overrides, target.gid, target.prop)?.value).toBe(target.scriptSizePt)
      }
    }
  })

  it('includes both sides of twin axes and excludes colorbars, hidden axes and non-axis text', () => {
    const m = manifest([
      ...manifest().elements,
      element('axes_1', 'axes', [], { follow_gids: ['axes_0'] }),
      element('axes_1.yticks', 'ticks', [size()]),
      element('axes_1.ylabel', 'axis_label', [size()]),
      element('axes_2', 'axes', [], { is_colorbar: true }),
      element('axes_2.yticks', 'ticks', [size()]),
      element('axes_2.ylabel', 'axis_label', [size()]),
      element('axes_2.colorbar', 'colorbar', [{ prop: 'tick_fontsize', type: 'number', value: 9 }]),
      element('axes_3', 'axes', [{ prop: 'visible', type: 'bool', value: false }]),
      element('axes_3.xticks', 'ticks', [size()]),
      element('axes_0.title', 'title', [size()]),
      element('axes_0.legend', 'legend', [size()]),
      element('axes_0.texts_0', 'text', [size()]),
      element('axes_0.xticklabels_0', 'ticklabel', [{ prop: 'text', type: 'text', value: '0' }]),
      element('axes_0.zlabel', 'axis_label', [size(), { prop: 'visible', type: 'bool', value: false }]),
    ])
    expect(ready(planPanelGridTypography(panel(), m, 12)).targets.map((target) => target.gid)).toEqual([
      'axes_0.xticks', 'axes_0.yticks', 'axes_0.xlabel', 'axes_0.ylabel', 'axes_1.yticks', 'axes_1.ylabel',
    ])
  })

  it('retains override order, duplicate history, identities and unrelated styles without mutating input', () => {
    const p = panel(0.75, { overrides: [
      { gid: 'axes_0.xticks', prop: 'fontsize', value: 5, identity: 'l1:older' },
      { gid: 'axes_0.xlabel', prop: 'fontfamily', value: 'Times New Roman' },
      { gid: 'axes_0.xticks', prop: 'fontsize', value: 7, identity: 'l1:effective' },
      { gid: 'axes_0.ylabel', prop: 'weight', value: 'bold' },
      { gid: 'axes_1.colorbar', prop: 'tick_fontsize', value: 6 },
    ] })
    const m = manifest()
    const original = structuredClone({ p, m })
    const plan = ready(planPanelGridTypography(p, m, 12))
    expect({ p, m }).toEqual(original)
    expect(plan.overrides.slice(0, 5)).toEqual([
      original.p.overrides[0], original.p.overrides[1],
      { ...original.p.overrides[2], value: 16 },
      original.p.overrides[3], original.p.overrides[4],
    ])
    expect(plan.overrides[0]).toBe(p.overrides[0])
    expect(plan.overrides[2]).not.toBe(p.overrides[2])
  })

  it('uses the last duplicate for no-op and avoids persisting already matching axis titles', () => {
    const p = panel(0.75, { overrides: [
      { gid: 'axes_0.xticks', prop: 'fontsize', value: 5 },
      { gid: 'axes_0.xticks', prop: 'fontsize', value: 16 },
    ] })
    const m = manifest([element('axes_0', 'axes'), element('axes_0.xticks', 'ticks', [size(16)])])
    const unchanged = ready(planPanelGridTypography(p, m, 12))
    expect(unchanged.changed).toBe(false)
    expect(unchanged.overrides).toBe(p.overrides)
    const source = panel(0.75)
    const labelManifest = manifest([element('axes_0', 'axes'), element('axes_0.xlabel', 'axis_label', [size(16)])])
    expect(ready(planPanelGridTypography(source, labelManifest, 12)).overrides).toBe(source.overrides)
  })

  it('writes matching source tick size once to normalize scientific offsets, then stays a no-op', () => {
    const p = panel(0.75)
    const m = manifest([element('axes_0', 'axes'), element('axes_0.xticks', 'ticks', [size(16)])])
    const first = ready(planPanelGridTypography(p, m, 12))
    expect(first.changed).toBe(true)
    expect(first.overrides).toEqual([{ gid: 'axes_0.xticks', prop: 'fontsize', value: 16 }])
    expect(p.overrides).toEqual([])
    const applied = { ...p, overrides: first.overrides }
    const second = ready(planPanelGridTypography(applied, m, 12))
    expect(second.changed).toBe(false)
    expect(second.overrides).toBe(first.overrides)
  })

  it('measures the full source size through cropping, rotation and flips', () => {
    const p = panel(0.75, {
      w: 60, h: 37.5, rotation: 90, flipH: true, flipV: true,
      crop: { x: 0.2, y: 0, w: 0.5, h: 1 },
    })
    const plan = ready(planPanelGridTypography(p, manifest(), 12))
    expect(plan.targets.every((target) => target.scriptSizePt === 16)).toBe(true)
    expect(plan.targets[0].scriptSizePt * (p.h / p.crop!.w / p.nativeW)).toBe(12)
  })

  it('leaves static assets and pies without visible axis text unchanged', () => {
    const p = panel()
    for (const m of [manifest([]), manifest([element('axes_0', 'axes'), element('axes_0.texts_0', 'text', [size()])])]) {
      expect(ready(planPanelGridTypography(p, m, 12))).toEqual({
        status: 'ready', overrides: p.overrides, changed: false, targets: [],
      })
    }
  })

  it.each([NaN, Infinity, -1, 0, 0.5, 401])('rejects invalid page size %s without patches', (value) => {
    expect(planPanelGridTypography(panel(), manifest(), value)).toMatchObject({ status: 'error', code: 'font_size_invalid' })
  })

  it('rejects a missing or non-numeric field instead of silently omitting an axis', () => {
    for (const fields of [[], [{ prop: 'fontsize', type: 'text', value: '9' } as EditableField]]) {
      const m = manifest([...manifest().elements, element('axes_0.zlabel', 'axis_label', fields)])
      expect(planPanelGridTypography(panel(), m, 12)).toMatchObject({ status: 'error', code: 'font_size_unsupported' })
    }
  })

  it('rejects target sizes outside script bounds after final scale conversion, without clamping', () => {
    const p = panel(0.4)
    const before = structuredClone(p)
    expect(planPanelGridTypography(p, manifest(), 12)).toMatchObject({ status: 'error', code: 'font_size_unsupported' })
    expect(p).toEqual(before)
    expect(planPanelGridTypography(panel(5), manifest(), 12)).toMatchObject({ status: 'error', code: 'font_size_unsupported' })
  })

  it.each(['figure', 'axes_0', 'axes_0.xlabel', 'axes_0.xticks', 'axes_0.xticklabels_0'])('reports locked axis target %s', (gid) => {
    expect(planPanelGridTypography(panel(1, { lockedGids: [gid] }), manifest(), 12))
      .toMatchObject({ status: 'error', code: 'font_size_unsupported' })
  })

  it('reports a locked panel or invalid scale while unrelated locked decorations remain untouched', () => {
    expect(planPanelGridTypography(panel(1, { locked: true }), manifest(), 12)).toMatchObject({ status: 'error', code: 'font_size_unsupported' })
    expect(planPanelGridTypography(panel(1, { nativeW: 0 }), manifest(), 12)).toMatchObject({ status: 'error', code: 'font_size_unsupported' })
    expect(ready(planPanelGridTypography(panel(1, { lockedGids: ['axes_0.legend'] }), manifest(), 12)).targets).toHaveLength(4)
  })
})
