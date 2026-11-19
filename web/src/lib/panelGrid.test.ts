import { describe, expect, it, vi } from 'vitest'
import type { Manifest } from './api'
import { panelAxesBounds } from './canvasAlignment'
import type { Rect } from './geometry'
import { DEFAULT_PANEL_GRID, normalizePanelGridSettings, panelGridReadingOrder, planPanelGrid, type PanelGridFrameBaseline, type PanelGridPlan, type PanelGridSettings } from './panelGrid'
import type { PanelObject } from '@/types/document'

const panel = (id: string, ratio = 4 / 3, extra: Partial<PanelObject> = {}): PanelObject => ({
  id, type: 'panel', fileId: `${id}.pdf`, fileKind: 'pdf', overrides: [],
  nativeW: ratio * 60, nativeH: 60, x: 0, y: 0, w: ratio * 60, h: 60, ...extra,
})
const manifest = (box: [number, number, number, number]): Manifest => ({
  stem: 'grid-geometry', size_mm: [100, 70], elements: [
    { gid: 'axes_0', role: 'axes', label: 'plot', bbox: box, draggable: true, editable: [] },
    // This wide colorbar and the figure's outer margins must remain contained,
    // but the colorbar axes must not be mistaken for the alignment line.
    { gid: 'axes_1', role: 'axes', label: 'bar', bbox: [0.89, 0.08, 0.08, 0.82], is_colorbar: true, draggable: false, editable: [] },
  ],
})
const ready = (plan: PanelGridPlan) => {
  expect(plan.status).toBe('ready')
  if (plan.status !== 'ready') throw new Error(`expected ready, got ${plan.status}`)
  return plan
}
const near = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 10)
const contained = (inside: Rect, outside: Rect) => {
  expect(inside.x).toBeGreaterThanOrEqual(outside.x - 1e-9)
  expect(inside.y).toBeGreaterThanOrEqual(outside.y - 1e-9)
  expect(inside.x + inside.w).toBeLessThanOrEqual(outside.x + outside.w + 1e-9)
  expect(inside.y + inside.h).toBeLessThanOrEqual(outside.y + outside.h + 1e-9)
}

describe('panel grid settings', () => {
  it('defaults to one 4:3 cell, 3 mm gaps, 8 mm margins and left/bottom axes lines', () => {
    expect(normalizePanelGridSettings(undefined)).toEqual(DEFAULT_PANEL_GRID)
    expect(normalizePanelGridSettings(null)).not.toHaveProperty('order')
    expect(normalizePanelGridSettings({ cols: 9.8, ratio: -2, gap: -1, margin: NaN, basis: 'invalid', columnAlign: 'x', rowAlign: 'x', order: ['b', '', 'a', 'b', 4, null] }, 3)).toEqual({
      ...DEFAULT_PANEL_GRID, cols: 3, gap: 0, order: ['b', 'a'],
    })
    expect(normalizePanelGridSettings({ cols: 4 })).toMatchObject({ cols: 4 })
    expect(normalizePanelGridSettings(undefined, 9)).toMatchObject({ cols: 3 })
    expect(normalizePanelGridSettings(undefined, 1)).toMatchObject({ cols: 1 })
    expect(normalizePanelGridSettings({ cols: Infinity, ratio: NaN, gap: '6', margin: -3 }, 0)).toMatchObject({ cols: 1, ratio: 4 / 3, gap: 3, margin: 0 })
    expect(normalizePanelGridSettings({ gap: 6 })).toMatchObject({ gap: 6 })
  })

  it('round-trips frame baselines including duplicate override order, identities and custom colors', () => {
    const baseline: PanelGridFrameBaseline = {
      sourceKey: 'panels/d.pdf|95.25|76.2',
      baselineOverrides: [
        { gid: 'axes_0', prop: 'position', value: [0.1, 0.2, 0.7, 0.6], identity: 'l1:initial' },
        { gid: 'axes_1.colorbar', prop: 'cmap', value: { type: 'custom', colors: ['#000000', '#ffffff', '#ff0000'], positions: [0, 0.5, 1] } },
        { gid: 'axes_0', prop: 'position', value: [0.17, 0.19, 0.57, 0.74], identity: 'l1:effective' },
      ],
      appliedOverrides: [{ gid: 'axes_0', prop: 'position', value: [0.17, 0.19, 0.57, 0.5344], identity: 'l1:effective' }],
    }
    const input = { cols: 3, order: ['d'], frames: { d: baseline, e: { sourceKey: 'e.pdf', baselineOverrides: [], appliedOverrides: [] } } }
    const before = structuredClone(input)
    const normalized = normalizePanelGridSettings(input)
    expect(normalized.frames).toEqual(input.frames)
    expect(normalizePanelGridSettings(JSON.parse(JSON.stringify(normalized)))).toEqual(normalized)
    expect(input).toEqual(before)
    expect(normalized.frames!.d.baselineOverrides[2].identity).toBe('l1:effective')
  })

  it('rejects malformed baseline entries whole instead of accepting a partial override history', () => {
    const valid = { sourceKey: 'a.pdf', baselineOverrides: [], appliedOverrides: [] }
    const invalid = [
      null, [], 'frame', {}, { ...valid, sourceKey: '' },
      { ...valid, baselineOverrides: null }, { ...valid, appliedOverrides: {} },
      { ...valid, appliedOverrides: [{ gid: 'axes_0', prop: 'position' }] },
      { ...valid, baselineOverrides: [{ gid: '', prop: 'position', value: [] }] },
      { ...valid, appliedOverrides: [{ gid: 'axes_0', prop: '', value: [] }] },
      { ...valid, appliedOverrides: [{ gid: 'axes_0', prop: 'position', value: [], identity: 3 }] },
      { ...valid, baselineOverrides: [{ gid: 'axes_0', prop: 'xlim', value: [NaN, 1] }] },
      { ...valid, appliedOverrides: [{ gid: 'axes_0', prop: 'position', value: undefined }] },
      { ...valid, baselineOverrides: [{ gid: 'axes_0', prop: 'visible', value: true }, null] },
    ]
    for (const bad of invalid) {
      expect(normalizePanelGridSettings({ frames: { a: valid, bad } }).frames).toEqual({ a: valid })
      expect(normalizePanelGridSettings({ frames: { bad } })).not.toHaveProperty('frames')
    }
    for (const badMap of [undefined, null, [], 'frames', 12, {}, { ' ': valid }]) {
      expect(normalizePanelGridSettings({ frames: badMap })).not.toHaveProperty('frames')
    }
    const cyclic: unknown[] = []
    cyclic.push(cyclic)
    expect(normalizePanelGridSettings({ frames: { a: { ...valid, appliedOverrides: [{ gid: 'axes_0', prop: 'value', value: cyclic }] } } }))
      .not.toHaveProperty('frames')
  })
})

describe('pure panel grid planning', () => {
  it('gives equal main frames to heatmaps and ordinary plots despite external colorbars and legends', () => {
    const panels = [panel('d', 1.25), panel('e', 1.25), panel('f', 1.25), panel('g', 1.25)]
    // The engine has already normalized these frames to 4:3; their source
    // fractions differ because d/e reserve more space for outside decorations.
    const frames = [[0.17, 0.275625, 0.57, 0.534375], [0.15, 0.2875, 0.6, 0.5625],
      [0.17, 0.13, 0.6826666666666666, 0.64], [0.19, 0.05, 0.7466666666666666, 0.7]] as [number, number, number, number][]
    const result = ready(planPanelGrid({ page: { w: 280, h: 220 }, panels, settings: { cols: 2 },
      resolveAxes: (p) => ({ status: 'ready', bounds: panelAxesBounds(p, manifest(frames[panels.indexOf(p)])) }),
    }))
    const [d, e, f, g] = result.cells.map((cell) => cell.alignmentBounds)
    for (const frame of [e, f, g]) {
      near(frame.w, d.w)
      near(frame.h, d.h)
    }
    near(d.x, f.x)
    near(d.x + d.w, f.x + f.w)
    near(d.y, e.y)
    near(d.y + d.h, e.y + e.h)
    result.cells.forEach((cell) => contained(cell.panelBounds, cell.bounds))
  })

  it('reads the actual nine-panel trial by row despite unequal picture margins and sizes', () => {
    // Geometry only from the local a-i trial; no scientific data enters the test.
    const rects = [
      [4, 3.5, 89, 71.2], [99.25, 3.5, 89, 71.2], [194.5, 3.5, 89, 71.2],
      [7.75, 79.9569587240156, 89, 71.2], [104.35464959490741, 74.7, 78.94427289733045, 63.15541831786436],
      [194.5, 73.30558891932809, 89, 71.2], [4, 153.4, 84.76298341936298, 67.8103867354904],
      [99.25, 153.4, 80.54287566749845, 64.43430053399877], [197, 153.4, 83.06969940098975, 66.4557595207918],
    ]
    const panels = rects.map(([x, y, w, h], i) => panel('abcdefghi'[i], 1.25, { x, y, w, h }))
    const shuffled = [panels[4], panels[5], panels[3], panels[8], panels[6], panels[7], panels[2], panels[0], panels[1]]
    const original = structuredClone(shuffled)
    expect(panelGridReadingOrder(shuffled).map((p) => p.id)).toEqual([...'abcdefghi'])
    const result = ready(planPanelGrid({ page: { w: 285.75, h: 228.6 }, panels: shuffled, settings: { basis: 'image' }, order: 'reading' }))
    expect(result.cells.map((cell) => cell.panelId)).toEqual([...'abcdefghi'])
    expect(shuffled).toEqual(original)
  })

  it('keeps adjacent rows distinct instead of chaining overlapping picture bands', () => {
    const panels = [panel('d', 1, { x: 100, y: 32, h: 40 }), panel('c', 1, { x: 0, y: 30, h: 40 }),
      panel('b', 1, { x: 100, y: 15, h: 40 }), panel('a', 1, { x: 0, y: 0, h: 40 })]
    expect(panelGridReadingOrder(panels).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd'])
    // Small upper figures fit within the tall peer's band, while the next row's
    // slightly overlapping pictures remain a separate row.
    const varied = [panel('a', 1, { x: 0, y: 0, h: 70 }), panel('b', 1, { x: 100, y: 20, h: 35 }),
      panel('c', 1, { x: 0, y: 66, h: 60 }), panel('d', 1, { x: 100, y: 75, h: 45 })]
    expect(panelGridReadingOrder([...varied].reverse()).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('aligns actual plot left and bottom lines for nine unequal figures while retaining all outer margins', () => {
    const ratios = [2.4, 0.7, 1.5, 1, 3, 0.9, 1.8, 1.25, 1.1]
    const panels = ratios.map((ratio, i) => panel(String(i), ratio, { x: i * 13, y: i * 9 }))
    const manifests = panels.map((_, i) => manifest([0.06 + i * 0.025, 0.05 + (i % 3) * 0.04, 0.62 - i * 0.018, 0.8 - i * 0.037]))
    const original = structuredClone(panels)
    const result = ready(planPanelGrid({ page: { w: 285.75, h: 228.6 }, panels, settings: { cols: 3 },
      resolveAxes: (p) => ({ status: 'ready', bounds: panelAxesBounds(p, manifests[Number(p.id)]) }),
    }))
    expect(panels).toEqual(original)
    expect(result.cells).toHaveLength(9)
    expect(result.scale).toBeLessThan(1)
    near(result.cellW / result.cellH, 4 / 3)
    const actualAxes = result.patches.map((patch, i) => panelAxesBounds({ ...panels[i], ...patch }, manifests[i])!)
    for (let i = 0; i < 9; i++) {
      near(result.patches[i].w / result.patches[i].h, ratios[i])
      contained(result.patches[i], result.cells[i].bounds)
      contained(result.cells[i].bounds, { x: 8, y: 8, w: 285.75 - 16, h: 228.6 - 16 })
      near(actualAxes[i].x, actualAxes[i % 3].x)
      near(actualAxes[i].y + actualAxes[i].h, actualAxes[Math.floor(i / 3) * 3].y + actualAxes[Math.floor(i / 3) * 3].h)
      near(result.cells[i].anchor.x, actualAxes[i].x)
      near(result.cells[i].anchor.y, actualAxes[i].y + actualAxes[i].h)
    }
    near(result.cells[1].bounds.x - result.cells[0].bounds.x - result.cells[0].bounds.w, 3)
    near(result.cells[3].bounds.y - result.cells[0].bounds.y - result.cells[0].bounds.h, 3)
  })

  it('packs complete picture envelopes at the requested gap without overlap or unused cell padding', () => {
    const page = { w: 285.75, h: 228.6 }
    const ratios = [2.4, 0.7, 1.5, 1, 3, 0.9, 1.8, 1.25, 1.1]
    const panels = ratios.map((ratio, i) => panel(String(i), ratio, { x: i * 13, y: i * 9 }))
    const manifests = panels.map((_, i) => manifest([0.06 + i * 0.025, 0.05 + (i % 3) * 0.04, 0.62 - i * 0.018, 0.8 - i * 0.037]))
    const resolveAxes = (p: PanelObject) => ({ status: 'ready' as const, bounds: panelAxesBounds(p, manifests[Number(p.id)]) })
    const result = ready(planPanelGrid({ page, panels, settings: { cols: 3, gap: 3 }, resolveAxes }))
    // Measure actual whole pictures, not cell metadata: blank margins, colorbars
    // and legends stay inside these rectangles and retain their editing targets.
    const extent = (axis: 'x' | 'y', index: number) => {
      const members = result.cells.filter((cell) => (axis === 'x' ? cell.col : cell.row) === index)
      const size = axis === 'x' ? 'w' : 'h'
      return [Math.min(...members.map((cell) => cell.panelBounds[axis])),
        Math.max(...members.map((cell) => cell.panelBounds[axis] + cell.panelBounds[size]))]
    }
    for (const axis of ['x', 'y'] as const) {
      for (let index = 0; index < 2; index++) near(extent(axis, index + 1)[0] - extent(axis, index)[1], 3)
    }
    result.cells.forEach((cell, i) => {
      near(cell.panelBounds.w / cell.panelBounds.h, ratios[i])
      contained(cell.panelBounds, cell.bounds)
      contained(cell.bounds, { x: 8, y: 8, w: page.w - 16, h: page.h - 16 })
      result.cells.slice(i + 1).forEach((other) => {
        const a = cell.panelBounds
        const b = other.panelBounds
        expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).toBe(false)
      })
    })
    near(result.grid.x * 2 + result.grid.w, page.w)
    near(result.grid.y * 2 + result.grid.h, page.h)
    expect(result.grid.w).toBeLessThan(result.cellW * 3 + 6)
    expect(result.grid.h).toBeLessThan(result.cellH * 3 + 6)
    // A saved/reopened layout uses its current exact axes geometry and remains
    // a no-op; tighter packing must not shrink or accumulate offsets on reapply.
    const reopened = JSON.parse(JSON.stringify(panels.map((p) => ({ ...p, ...result.patches.find((patch) => patch.id === p.id) })))) as PanelObject[]
    const repeated = ready(planPanelGrid({ page, panels: reopened, settings: result.settings, resolveAxes }))
    expect(repeated.patches).toEqual([])
  })

  it.each(['start', 'center', 'end'] as const)('shares %s anchors and keeps unequal pictures inside their slots', (align) => {
    const panels = [panel('a', 2), panel('b', 0.7), panel('c', 1.8), panel('d', 1)]
    const boxes = [manifest([0.1, 0.05, 0.7, 0.8]), manifest([0.3, 0.2, 0.6, 0.6]), manifest([0.2, 0.05, 0.6, 0.7]), manifest([0.05, 0.3, 0.7, 0.65])]
    const result = ready(planPanelGrid({ page: { w: 180, h: 160 }, panels,
      settings: { cols: 2, columnAlign: align, rowAlign: align, gap: 9 },
      resolveAxes: (p) => ({ status: 'ready', bounds: panelAxesBounds(p, boxes[panels.findIndex((a) => a.id === p.id)]) }),
    }))
    const axes = result.patches.map((p, i) => panelAxesBounds({ ...panels[i], ...p }, boxes[i])!)
    const part = align === 'start' ? 0 : align === 'center' ? 0.5 : 1
    near(axes[0].x + axes[0].w * part, axes[2].x + axes[2].w * part)
    near(axes[0].y + axes[0].h * part, axes[1].y + axes[1].h * part)
    result.patches.forEach((p, i) => contained(p, result.cells[i].bounds))
    near(result.cells[1].bounds.x - result.cells[0].bounds.x - result.cells[0].bounds.w, 9)
  })

  it('changes a 1x1 cell ratio without stretching the native source, even if it was already stretched', () => {
    const p = panel('a', 2, { w: 60, h: 80, aspectLocked: false })
    const first = ready(planPanelGrid({ page: { w: 180, h: 120 }, panels: [p], settings: { basis: 'image' } }))
    const second = ready(planPanelGrid({ page: { w: 180, h: 120 }, panels: [p], settings: { basis: 'image', ratio: 1 } }))
    near(first.cellW / first.cellH, 4 / 3)
    near(second.cellW / second.cellH, 1)
    near(first.patches[0].w / first.patches[0].h, 2)
    near(second.patches[0].w / second.patches[0].h, 2)
    expect(first.patches[0].w).toBeGreaterThan(second.patches[0].w)
    expect(first.rows).toBe(1)
    expect(first.cols).toBe(1)
  })

  it('preserves native cropped/rotated aspect and computes actual flipped axes after layout', () => {
    const panels = [panel('a', 2, { crop: { x: 0.1, y: 0.1, w: 0.7, h: 0.8 }, rotation: 90, flipH: true, w: 64, h: 112 }),
      panel('b', 1.4, { crop: { x: 0, y: 0.05, w: 0.9, h: 0.9 }, rotation: 270, flipV: true, x: 100, w: 90, h: 126 })]
    const mf = manifest([0.15, 0.2, 0.6, 0.65])
    const result = ready(planPanelGrid({ page: { w: 220, h: 180 }, panels, settings: { cols: 2 },
      resolveAxes: (p) => ({ status: 'ready', bounds: panelAxesBounds(p, mf) }),
    }))
    near(result.patches[0].w / result.patches[0].h, 0.8 / (2 * 0.7))
    near(result.patches[1].w / result.patches[1].h, 1 / 1.4)
    const boxes = result.patches.map((patch, i) => panelAxesBounds({ ...panels[i], ...patch }, mf)!)
    near(boxes[0].y + boxes[0].h, boxes[1].y + boxes[1].h)
    result.patches.forEach((p, i) => contained(p, result.cells[i].bounds))
  })

  it('does not read axes in image mode; explicit static fallback is distinct from unknown geometry', () => {
    const panels = [panel('a'), panel('b')]
    const resolver = vi.fn(() => ({ status: 'pending' as const }))
    ready(planPanelGrid({ page: { w: 180, h: 180 }, panels, settings: { basis: 'image' }, resolveAxes: resolver }))
    expect(resolver).not.toHaveBeenCalled()
    const staticPlan = ready(planPanelGrid({ page: { w: 180, h: 180 }, panels,
      resolveAxes: () => ({ status: 'ready', bounds: null }),
    }))
    expect(staticPlan.fallbackIds).toEqual(['a', 'b'])
    expect(staticPlan.cells.every((cell) => cell.basis === 'image')).toBe(true)
    const waiting = planPanelGrid({ page: { w: 180, h: 180 }, panels,
      resolveAxes: (p) => p.id === 'a' ? { status: 'ready', bounds: null } : { status: 'pending' },
    })
    expect(waiting).toMatchObject({ status: 'pending', pendingIds: ['b'], patches: [], cells: [] })
  })

  it('is deterministic after applying the plan and retains input order independently of metadata', () => {
    const panels = [panel('b', 1.3, { x: 110, y: 5 }), panel('a', 1.2), panel('c', 1, { y: 80 })]
    const settings: Partial<PanelGridSettings> = { cols: 2, basis: 'image', order: ['c', 'a', 'b'] }
    const first = ready(planPanelGrid({ page: { w: 190, h: 170 }, panels, settings }))
    expect(first.patches.map((p) => p.id)).toEqual(['b', 'a', 'c'])
    const second = ready(planPanelGrid({ page: { w: 190, h: 170 }, panels: panels.map((p, i) => ({ ...p, ...first.patches[i] })), settings }))
    expect(second.patches).toEqual([])
    second.cells.forEach((cell, i) => {
      near(cell.panelBounds.x, first.cells[i].panelBounds.x)
      near(cell.panelBounds.y, first.cells[i].panelBounds.y)
      near(cell.panelBounds.w, first.cells[i].panelBounds.w)
      near(cell.panelBounds.h, first.cells[i].panelBounds.h)
    })
    const ordered = ready(planPanelGrid({ page: { w: 190, h: 170 }, panels, settings, order: 'reading' }))
    expect(ordered.patches.map((p) => p.id)).toEqual(['a', 'b', 'c'])
  })

  it('ignores hidden panels and blocks locked, pinned or grouped members without a partial plan', () => {
    const hidden = panel('hidden', 1, { hidden: true, locked: true, groupId: 'g' })
    const page = { w: 160, h: 120 }
    const settings = { basis: 'image' as const }
    expect(ready(planPanelGrid({ page, settings, panels: [panel('a'), hidden] })).patches.map((p) => p.id)).toEqual(['a'])
    for (const [flags, reason] of [[{ locked: true }, 'locked'], [{ layoutPinned: true }, 'locked'], [{ groupId: 'g' }, 'group']] as const) {
      expect(planPanelGrid({ page, settings, panels: [panel('a'), panel('b', 1, flags)] })).toMatchObject({ status: 'blocked', reason, ids: ['b'], patches: [], cells: [] })
    }
  })

  it('blocks impossible page/cell sizes and invalid source or authority bounds explicitly', () => {
    const p = panel('a')
    expect(planPanelGrid({ page: { w: 20, h: 20 }, panels: [p] })).toMatchObject({ status: 'blocked', reason: 'size', patches: [] })
    expect(planPanelGrid({ page: { w: 100, h: 100 }, panels: [p], settings: { gap: 100 }, resolveAxes: () => ({ status: 'ready', bounds: null }) }).status).toBe('ready')
    expect(planPanelGrid({ page: { w: 100, h: 100 }, panels: [p, panel('b')], settings: { cols: 2, gap: 100 } })).toMatchObject({ status: 'blocked', reason: 'size' })
    expect(planPanelGrid({ page: { w: NaN, h: 100 }, panels: [p] })).toMatchObject({ status: 'blocked', reason: 'invalid' })
    expect(planPanelGrid({ page: { w: 100, h: 100 }, panels: [panel('a', 1, { nativeW: 0 })] })).toMatchObject({ status: 'blocked', reason: 'invalid', ids: ['a'] })
    expect(planPanelGrid({ page: { w: 100, h: 100 }, panels: [p], resolveAxes: () => ({ status: 'ready', bounds: { x: -3, y: 0, w: 5, h: 5 } }) })).toMatchObject({ status: 'blocked', reason: 'invalid', ids: ['a'] })
  })
})
