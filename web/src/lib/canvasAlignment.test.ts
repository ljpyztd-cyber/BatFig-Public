import { describe, expect, it } from 'vitest'
import type { Manifest, ManifestElement } from './api'
import type { PanelObject } from '@/types/document'
import { canvasAlignmentGeometry, panelAxesBounds } from './canvasAlignment'

export const panel = (id: string, patch: Partial<PanelObject> = {}): PanelObject => ({
  id, type: 'panel', fileId: `${id}.pdf`, fileKind: 'pdf', name: id,
  nativeW: 100, nativeH: 50, x: 10, y: 20, w: 100, h: 50, overrides: [], ...patch,
})
export const axes = (gid: string, bbox: ManifestElement['bbox'], patch: Partial<ManifestElement> = {}): ManifestElement => ({
  gid, bbox, role: 'axes', label: gid, editable: [], draggable: true, ...patch,
})
export const manifest = (...elements: ManifestElement[]): Manifest => ({
  stem: 'alignment-fixture', elements, size_mm: [100, 50],
})

describe('plotting-area bounds for canvas alignment', () => {
  it('uses drawn axes, excluding colorbars and hidden axes, with twin axes counted once', () => {
    const m = manifest(
      axes('axes_0', [0.15, 0.1, 0.6, 0.7]),
      axes('axes_1', [0.15, 0.1, 0.6, 0.7]),
      axes('axes_2', [0.85, 0.1, 0.04, 0.7], { is_colorbar: true }),
      axes('axes_3', [0, 0, 1, 1], { editable: [{ prop: 'visible', type: 'bool', value: false }] }),
    )
    expect(panelAxesBounds(panel('p'), m)).toEqual({ x: 25, y: 25, w: 60, h: 35 })
  })

  it('unites plotting areas without expanding to external top legends or side colorbars', () => {
    const m = manifest(axes('a', [0.1, 0.1, 0.3, 0.6]), axes('b', [0.6, 0.2, 0.3, 0.5]))
    const box = panelAxesBounds(panel('p'), m)!
    expect(box.x).toBeCloseTo(20)
    expect(box.y).toBeCloseTo(25)
    expect(box.w).toBeCloseTo(80)
    expect(box.h).toBeCloseTo(30)

    const externalLegend: ManifestElement = {
      gid: 'legend', role: 'legend', label: 'outside top legend',
      bbox: [0.1, -0.2, 0.8, 0.15], editable: [], draggable: true,
    }
    const externalColorbar = axes('colorbar', [0.95, 0.1, 0.04, 0.8], { is_colorbar: true })
    const decorated = manifest(...m.elements, externalLegend, externalColorbar)
    expect(panelAxesBounds(panel('p'), decorated)).toEqual(box)

    // Changing the size/location of either external object must not become an
    // alignment input, even when its bounds surround the whole plotting area.
    externalLegend.bbox = [-5, -7, 12, 11]
    externalColorbar.bbox = [-3, -2, 8, 9]
    expect(panelAxesBounds(panel('p'), decorated)).toEqual(box)
  })

  it('maps cropping, horizontal flip and 90-degree rotation in the same order as PanelView', () => {
    const p = panel('p', {
      w: 40, h: 80, rotation: 90, flipH: true,
      crop: { x: 0.2, y: 0, w: 0.8, h: 1 },
    })
    // Before flip/rotation: x=10..60, y=46..70, around page centre (30,60).
    const box = panelAxesBounds(p, manifest(axes('a', [0.4, 0.15, 0.5, 0.6])))!
    expect(box.x).toBeCloseTo(20)
    expect(box.y).toBeCloseTo(30)
    expect(box.w).toBeCloseTo(24)
    expect(box.h).toBeCloseTo(50)
  })

  it('requires exact geometry for unknown panels; static and axis-free panels explicitly use bounds', () => {
    const p = panel('p')
    expect(canvasAlignmentGeometry([p], 'axes', () => null, () => false).pending).toBe(true)
    const staticResult = canvasAlignmentGeometry([p], 'axes', () => null, () => true)
    expect(staticResult.pending).toBe(false)
    expect(staticResult.fallbackCount).toBe(1)
    expect(staticResult.boxes.get(p.id)).toEqual({ x: 10, y: 20, w: 100, h: 50 })
    expect(canvasAlignmentGeometry([p], 'axes', () => manifest(), () => false).fallbackCount).toBe(1)
    expect(canvasAlignmentGeometry([p], 'image', () => { throw Error('must not read geometry') }, () => false).pending).toBe(false)
  })
})
