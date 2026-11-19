import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { literal } from '@/i18n'
import type { Manifest, ManifestElement } from '@/lib/api'
import { effectiveOverride } from '@/lib/effectiveOverride'
import { panelAxesBounds } from '@/lib/canvasAlignment'
import { currentContentKey } from '@/lib/documentCheckpoint'
import { seedExactRender } from '@/test/renderFixtures'
import { emptyProject, type PanelObject, type PanelOverride, type TextObject } from '@/types/document'
import { useDocumentStore } from './documentStore'
import { applyPanelGrid, preparePanelGrid, readPanelGrid } from './panelGrid'
import { exactPanelManifest, useRenderStore } from './renderStore'
import * as scheduler from './renderScheduler'
import { useUiStore } from './uiStore'
import { addSubLabels } from './actions'
import { useAssetStore } from './assetStore'

const engineRender = vi.fn()
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  engineRender: (...args: unknown[]) => engineRender(...args),
}))

const panel = (id: string, x: number, y: number): PanelObject => ({
  id, type: 'panel', fileId: `${id}.pdf`, fileKind: 'pdf', script: `${id}.py`,
  x, y, w: 90, h: 70, nativeW: 90, nativeH: 70, overrides: [],
})
const manifest = (index: number): Manifest => ({
  stem: 'grid-fixture', size_mm: [90, 70], elements: [{
    gid: 'axes_0', role: 'axes', label: 'axes', draggable: true, editable: [],
    bbox: [0.1 + index * 0.03, 0.1, 0.7, 0.7 - index * 0.02],
  }],
})
const panels = () => useDocumentStore.getState().doc.objects.filter((object): object is PanelObject => object.type === 'panel')
const label = (): TextObject => useDocumentStore.getState().doc.objects.find((object) => object.id === 'label') as TextObject

/** This renderer models source-space font sizes independently of canvas scale. */
const typographyManifest = (index: number, overrides: PanelOverride[] = [], ignoreFonts = false): Manifest => {
  const source = index % 2 ? [0.15, 0.2, 0.72, 0.6] : [0.15, 0.2, 0.48, 0.7]
  const pos = effectiveOverride(overrides, 'axes_0', 'position')?.value as number[] ?? source
  const [x, y, w, h] = pos
  return { stem: 'axis-typography', size_mm: [90, 70], elements: [{
    gid: 'axes_0', role: 'axes', identity: 'l1:plot', label: 'plot', draggable: true, resizable: true,
    bbox: [x, 1 - y - h, w, h], editable: [
      { prop: 'position', type: 'rect', value: pos },
      { prop: 'aspect', type: 'text', value: 'auto' },
    ],
  }, ...['xticks', 'yticks', 'xlabel', 'ylabel'].map((name): ManifestElement => {
    const gid = `axes_0.${name}`
    const tick = name.endsWith('ticks')
    const font = ignoreFonts ? undefined : effectiveOverride(overrides, gid, 'fontsize')?.value
    return {
      gid, role: tick ? 'ticks' : 'axis_label', identity: `l1:${name}`, label: name, draggable: false,
      bbox: [x, 1 - y - h, w, 0.05] as [number, number, number, number],
      editable: [
        { prop: 'fontsize', type: 'number', value: font ?? (tick ? 8 : 10) + index, min: 3, max: tick ? 24 : 36 },
        { prop: 'fontfamily', type: 'enum', value: 'Arial', options: ['Arial', 'Times New Roman'] },
        { prop: 'weight', type: 'enum', value: 'normal', options: ['normal', 'bold'] },
      ],
    }
  }), {
    gid: 'axes_0.lines_0', role: 'line', label: 'curve', draggable: false,
    bbox: [x, 1 - y - h, w, h], editable: [{
      prop: 'color', type: 'color', value: effectiveOverride(overrides, 'axes_0.lines_0', 'color')?.value ?? '#000000',
    }],
  }] }
}
const seedTypography = (ignoreFile?: string) => {
  panels().forEach((p, index) => seedExactRender(p, typographyManifest(index, p.overrides)))
  engineRender.mockImplementation(async (id: string, overrides: PanelOverride[]) => ({
    rev: 2, svg: '<svg/>', warnings: [],
    manifest: typographyManifest(id.charCodeAt(0) - 'a'.charCodeAt(0), overrides, id === ignoreFile),
  }))
}
const expectPageAxisSize = (sizePt = 12) => {
  for (const p of panels()) {
    const exact = exactPanelManifest(useRenderStore.getState(), p)
    expect(exact, `${p.id} exact rendered variant`).not.toBeNull()
    const texts = exact!.elements.filter((el) => el.role === 'ticks' || el.role === 'axis_label')
    expect(texts).toHaveLength(4)
    for (const el of texts) {
      const scriptPt = Number(el.editable.find((field) => field.prop === 'fontsize')!.value)
      // Read the render result and final physical dimensions, not the requested override.
      const pagePt = scriptPt * p.w / p.nativeW
      expect(Math.abs(pagePt - sizePt), `${p.id}/${el.gid}: ${pagePt} page pt`).toBeLessThanOrEqual(0.005 * p.w / p.nativeW + 1e-6)
    }
  }
}

beforeEach(async () => {
  engineRender.mockReset()
  useRenderStore.getState().clear()
  useAssetStore.getState().clear()
  await useDocumentStore.getState().switchDocument(emptyProject(), 'panel-grid-tests')
  useDocumentStore.getState().commit(literal('setup'), (doc) => {
    doc.page = { w: 280, h: 220 }
    doc.objects = [panel('a', 0, 0), panel('b', 100, 0), panel('c', 0, 80), panel('d', 100, 80), {
      id: 'label', type: 'text', text: '(a)', panelLabelFor: 'a', x: 2, y: 1, w: 8, h: 5,
      sizePt: 10, color: '#000000', bold: true, align: 'left',
    }]
  })
  useDocumentStore.setState({ past: [], future: [] })
  panels().forEach((object, index) => seedExactRender(object, manifest(index)))
})
afterEach(() => vi.restoreAllMocks())

describe('canvas panel grid action', () => {
  it('uses 8 page pt by default and lets the user choose 10 pt', async () => {
    seedTypography()
    await applyPanelGrid()
    expectPageAxisSize(8)
    expect(useDocumentStore.getState().doc.panelGrid?.axisFontSizePt).toBe(8)
    await applyPanelGrid({ axisFontSizePt: 10 })
    expectPageAxisSize(10)
  })
  it('renders all axis text at 12 page pt across different panel scales in one reversible commit', async () => {
    seedTypography()
    const before = currentContentKey(useDocumentStore.getState())
    const originalObjects = structuredClone(useDocumentStore.getState().doc.objects)
    await applyPanelGrid({ axisFontSizePt: 12 })
    expectPageAxisSize()
    expect(new Set(panels().map((p) => (p.w / p.nativeW).toFixed(4))).size).toBeGreaterThan(1)
    expect(useDocumentStore.getState().doc.panelGrid?.axisFontSizePt).toBe(12)
    expect(useDocumentStore.getState().past).toHaveLength(1)
    expect(label()).toMatchObject({ sizePt: 10, bold: true })
    for (const p of panels()) {
      expect(effectiveOverride(p.overrides, 'axes_0.xticks', 'fontsize')?.identity).toBe('l1:xticks')
      expect(p.overrides.some((override) => override.prop === 'fontfamily' || override.prop === 'weight')).toBe(false)
    }
    const after = currentContentKey(useDocumentStore.getState())
    useDocumentStore.getState().undo()
    expect(currentContentKey(useDocumentStore.getState())).toBe(before)
    expect(useDocumentStore.getState().doc.objects).toEqual(originalObjects)
    useDocumentStore.getState().redo()
    expect(currentContentKey(useDocumentStore.getState())).toBe(after)
    expectPageAxisSize()
    engineRender.mockClear()
    await applyPanelGrid()
    expect(currentContentKey(useDocumentStore.getState())).toBe(after)
    expect(useDocumentStore.getState().past).toHaveLength(1)
    expect(engineRender).not.toHaveBeenCalled()
  })

  it('rejects a renderer that ignores font size without committing any panels, labels or settings', async () => {
    seedTypography('b.pdf')
    const before = currentContentKey(useDocumentStore.getState())
    const history = useDocumentStore.getState().past
    await applyPanelGrid()
    expect(engineRender.mock.calls.some(([, patches]) =>
      (patches as PanelOverride[]).some((patch) => patch.prop === 'fontsize'))).toBe(true)
    expect(currentContentKey(useDocumentStore.getState())).toBe(before)
    expect(useDocumentStore.getState().past).toBe(history)
    expect(useUiStore.getState().status).toMatchObject({ key: 'panelGrid.font_size_mismatch' })
  })

  it('retains original plot-frame baselines and 12 page pt through ratio/gap changes and reopening', async () => {
    seedTypography()
    await applyPanelGrid({ axisFontSizePt: 12 })
    expectPageAxisSize()
    const first = structuredClone(panels())
    const firstFrames = structuredClone(useDocumentStore.getState().doc.panelGrid!.frames!)
    expect(Object.keys(firstFrames)).toHaveLength(4)
    for (const frame of Object.values(firstFrames)) {
      expect(effectiveOverride(frame.baselineOverrides, 'axes_0', 'position')).toBeUndefined()
      expect(frame.baselineOverrides.some((override) => override.prop === 'fontsize')).toBe(true)
    }
    await applyPanelGrid({ ratio: 1, gap: 6 })
    expectPageAxisSize()
    expect(panels().map((p) => [p.w, p.h])).not.toEqual(first.map((p) => [p.w, p.h]))
    await applyPanelGrid({ ratio: 4 / 3, gap: 3 })
    expectPageAxisSize()
    panels().forEach((p, index) => {
      const previous = first[index]
      for (const key of ['x', 'y', 'w', 'h'] as const) expect(p[key]).toBeCloseTo(previous[key], 8)
      expect({ ...p, x: previous.x, y: previous.y, w: previous.w, h: previous.h }).toEqual(previous)
    })
    expect(useDocumentStore.getState().doc.panelGrid!.frames).toEqual(firstFrames)
    const saved = JSON.parse(JSON.stringify(useDocumentStore.getState().buildProject()))
    await useDocumentStore.getState().switchDocument(saved, 'axis-fonts-reopened')
    const reopened = currentContentKey(useDocumentStore.getState())
    engineRender.mockClear()
    await applyPanelGrid()
    expect(currentContentKey(useDocumentStore.getState())).toBe(reopened)
    expect(useDocumentStore.getState().past).toHaveLength(0)
    expectPageAxisSize()
    expect(engineRender).not.toHaveBeenCalled()
  })

  it('normalizes axis fonts in image mode and preserves newer curve edits across a return to axes mode', async () => {
    seedTypography()
    await applyPanelGrid()
    const oldFrame = structuredClone(useDocumentStore.getState().doc.panelGrid!.frames!.a)
    useDocumentStore.getState().commit(literal('recolor curve'), (draft) => {
      (draft.objects.find((o) => o.id === 'a') as PanelObject).overrides.push({
        gid: 'axes_0.lines_0', prop: 'color', value: '#d2691e',
      })
    })
    seedTypography()
    await applyPanelGrid({ basis: 'image', axisFontSizePt: 11.5 })
    expectPageAxisSize(11.5)
    expect(useDocumentStore.getState().doc.panelGrid!.frames?.a).not.toEqual(oldFrame)
    expect(effectiveOverride(panels()[0].overrides, 'axes_0.lines_0', 'color')?.value).toBe('#d2691e')
    await applyPanelGrid({ basis: 'axes', ratio: 1, axisFontSizePt: 12 })
    expectPageAxisSize()
    const a = panels()[0]
    expect(effectiveOverride(a.overrides, 'axes_0.lines_0', 'color')?.value).toBe('#d2691e')
    expect(exactPanelManifest(useRenderStore.getState(), a)!.elements.find((el) => el.gid === 'axes_0.lines_0')?.editable)
      .toContainEqual({ prop: 'color', type: 'color', value: '#d2691e' })
  })

  it('commits verified axes, labels and reusable baselines in one undo step', async () => {
    const editable = (index: number, overrides: PanelOverride[] = []): Manifest => {
      const source = index ? [0.15, 0.2, 0.72, 0.6] : [0.15, 0.2, 0.48, 0.7]
      const pos = effectiveOverride(overrides, 'axes_0', 'position')?.value as number[] ?? source
      const [x, y, w, h] = pos
      return { stem: 'editable', size_mm: [90, 70], elements: [{
        gid: 'axes_0', role: 'axes', identity: 'l1:plot', label: 'plot', draggable: true, resizable: true,
        bbox: [x, 1 - y - h, w, h], editable: [
          { prop: 'position', type: 'rect', value: pos },
          { prop: 'aspect', type: 'text', value: 'auto' },
        ],
      }] }
    }
    panels().forEach((p, index) => seedExactRender(p, editable(index)))
    engineRender.mockImplementation(async (id: string, overrides: PanelOverride[]) => ({
      rev: 2, svg: '<svg/>', warnings: [], manifest: editable(id === 'a.pdf' ? 0 : 1, overrides),
    }))
    const before = currentContentKey(useDocumentStore.getState())
    expect((await applyPanelGrid()).status).toBe('ready')
    expect(useDocumentStore.getState().past).toHaveLength(1)
    expect(panels().every((p) => effectiveOverride(p.overrides, 'axes_0', 'position')?.identity === 'l1:plot')).toBe(true)
    const after = currentContentKey(useDocumentStore.getState())
    useDocumentStore.getState().undo()
    expect(currentContentKey(useDocumentStore.getState())).toBe(before)
    useDocumentStore.getState().redo()
    expect(currentContentKey(useDocumentStore.getState())).toBe(after)
    await applyPanelGrid()
    expect(currentContentKey(useDocumentStore.getState())).toBe(after)
    const original = panels().map((p) => p.overrides)
    const frames = structuredClone(useDocumentStore.getState().doc.panelGrid!.frames)
    await applyPanelGrid({ basis: 'image', frames: {} })
    expect(useDocumentStore.getState().doc.panelGrid!.frames).toEqual(frames)
    await applyPanelGrid({ basis: 'axes' })
    useDocumentStore.getState().commit(literal('hide plot'), (draft) => { draft.objects[0].hidden = true })
    await applyPanelGrid()
    expect(useDocumentStore.getState().doc.panelGrid!.frames?.a).toEqual(frames?.a)
    useDocumentStore.getState().commit(literal('show plot'), (draft) => { draft.objects[0].hidden = false })
    await applyPanelGrid()
    const saved = JSON.parse(JSON.stringify(useDocumentStore.getState().buildProject()))
    const copyId = useDocumentStore.getState().duplicateCanvas(useDocumentStore.getState().activeCanvasId)!
    const copy = useDocumentStore.getState().canvases.find((canvas) => canvas.id === copyId)!
    expect(Object.keys(copy.panelGrid!.frames!)).toEqual(copy.objects.filter((p) => p.type === 'panel').map((p) => p.id))
    expect(Object.values(copy.panelGrid!.frames!)).toEqual(Object.values(saved.canvases[0].panelGrid.frames))
    await useDocumentStore.getState().switchDocument(saved, 'plot-frame-reopened')
    await applyPanelGrid({ ratio: 1 })
    await applyPanelGrid({ ratio: 4 / 3 })
    expect(panels().map((p) => p.overrides)).toEqual(original)
  })

  it('records left-to-right row order despite differing top margins and preserves an existing order', async () => {
    useDocumentStore.getState().commit(literal('different row margins'), (doc) => {
      doc.objects = [panel('f', 194.5, 73.31), panel('e', 104.35, 74.7), panel('d', 7.75, 79.96),
        panel('c', 194.5, 3.5), panel('b', 99.25, 3.5), panel('a', 4, 3.5),
        panel('i', 197, 153.4), panel('h', 99.25, 153.4), panel('g', 4, 153.4)]
    })
    panels().forEach((object) => seedExactRender(object, manifest(0)))
    expect(readPanelGrid().settings.order).toEqual([...'abcdefghi'])
    await applyPanelGrid()
    expect(useDocumentStore.getState().doc.panelGrid?.order).toEqual([...'abcdefghi'])
    const explicit = ['i', 'h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']
    await applyPanelGrid({ order: explicit })
    expect(readPanelGrid({ ratio: 1 }).settings.order).toEqual(explicit)
  })

  it('aligns same-column left and same-row bottom axes with one undo including labels/settings', async () => {
    const before = currentContentKey(useDocumentStore.getState())
    const plan = await applyPanelGrid()
    expect(plan.status).toBe('ready')
    const [a, b, c, d] = panels().map((object, index) => panelAxesBounds(object, manifest(index))!)
    expect(a.x).toBeCloseTo(c.x, 3)
    expect(b.x).toBeCloseTo(d.x, 3)
    expect(a.y + a.h).toBeCloseTo(b.y + b.h, 3)
    expect(c.y + c.h).toBeCloseTo(d.y + d.h, 3)
    expect(panels().every((object) => object.overrides.length === 0)).toBe(true)
    expect(label().x).not.toBe(2)
    expect(label().sizePt).toBe(10)
    expect(useDocumentStore.getState().past).toHaveLength(1)
    const after = currentContentKey(useDocumentStore.getState())
    useDocumentStore.getState().undo()
    expect(currentContentKey(useDocumentStore.getState())).toBe(before)
    useDocumentStore.getState().redo()
    expect(currentContentKey(useDocumentStore.getState())).toBe(after)
  })

  it('repeated application is a no-op and saved order survives changing row geometry', async () => {
    await applyPanelGrid()
    const first = currentContentKey(useDocumentStore.getState())
    await applyPanelGrid()
    expect(currentContentKey(useDocumentStore.getState())).toBe(first)
    expect(useDocumentStore.getState().past).toHaveLength(1)
    await applyPanelGrid({ ratio: 1, gap: 8, rowAlign: 'start', columnAlign: 'end' })
    expect(useDocumentStore.getState().doc.panelGrid?.order).toEqual(['a', 'b', 'c', 'd'])
    expect(useDocumentStore.getState().past).toHaveLength(2)
  })

  it('aligns nine regular Arial labels by row/column and retains them through undo, save and reopen', async () => {
    useDocumentStore.getState().commit(literal('nine figures'), (doc) => {
      doc.objects = [...'abcdefghi'].flatMap((id, index) => {
        const p = panel(id, index % 3 * 95 + index, Math.floor(index / 3) * 75 + index * 0.3)
        return [p, {
          id: `label-${id}`, type: 'text' as const, text: id, panelLabelFor: id,
          x: p.x - index, y: p.y + index, w: 5, h: 9, fontFamily: 'Arial' as const,
          sizePt: 20, bold: false, color: '#000000', align: 'left' as const,
        }]
      })
    })
    panels().forEach((p, index) => seedExactRender(p, manifest(index % 4)))
    const before = currentContentKey(useDocumentStore.getState())
    const layout = await applyPanelGrid()
    expect(layout.status).toBe('ready')
    const texts = () => useDocumentStore.getState().doc.objects.filter((o): o is TextObject => o.type === 'text')
    for (let row = 0; row < 3; row++) {
      expect(new Set(texts().slice(row * 3, row * 3 + 3).map((o) => o.y)).size).toBe(1)
    }
    for (let col = 0; col < 3; col++) {
      expect(new Set(texts().filter((_, index) => index % 3 === col).map((o) => o.x)).size).toBe(1)
    }
    expect(texts().every((o) => o.fontFamily === 'Arial' && o.sizePt === 20 && !o.bold)).toBe(true)
    const aligned = texts()
    const after = currentContentKey(useDocumentStore.getState())
    useDocumentStore.getState().undo()
    expect(currentContentKey(useDocumentStore.getState())).toBe(before)
    useDocumentStore.getState().redo()
    expect(currentContentKey(useDocumentStore.getState())).toBe(after)
    await applyPanelGrid()
    expect(currentContentKey(useDocumentStore.getState())).toBe(after)
    const saved = JSON.parse(JSON.stringify(useDocumentStore.getState().buildProject()))
    await useDocumentStore.getState().switchDocument(saved, 'nine-reopened')
    expect(texts()).toEqual(aligned)
  })

  it('new labels use occupied grid cells, but never a future layout of unarranged figures', async () => {
    await applyPanelGrid()
    const cells = readPanelGrid().cells
    addSubLabels()
    const created = useDocumentStore.getState().doc.objects.filter((o): o is TextObject => o.type === 'text' && o.id !== 'label')
    expect(created).toHaveLength(4)
    expect(created[0].x).toBe(created[2].x)
    expect(created[0].y).toBe(created[1].y)
    created.forEach((o, i) => {
      expect(o.panelLabelFor).toBe(cells[i].panelId)
      expect(o.x).toBeCloseTo(cells[i].bounds.x + 1.5, 10)
      expect(o.y).toBeCloseTo(cells[i].bounds.y + 1, 10)
    })
    useDocumentStore.getState().commit(literal('swap two figures'), (doc) => {
      doc.objects = doc.objects.filter((o) => o.type === 'panel')
      const x = doc.objects[0].x
      doc.objects[0].x = doc.objects[1].x
      doc.objects[1].x = x
    })
    const current = panels()[0]
    expect(readPanelGrid().patches.length).toBeGreaterThan(0)
    addSubLabels()
    expect(useDocumentStore.getState().doc.objects.find((o) => o.type === 'text'))
      .toMatchObject({ text: '(a)', panelLabelFor: 'b' })
    expect(useDocumentStore.getState().doc.objects.find((o) => o.type === 'text' && o.panelLabelFor === current.id))
      .toMatchObject({ x: current.x + 1.5, y: current.y + 1 })
  })

  it('never uses a stale rendering and preparation is explicit', async () => {
    const render = vi.spyOn(scheduler, 'requestRender').mockImplementation(() => {})
    const before = currentContentKey(useDocumentStore.getState())
    useRenderStore.getState().markStale(['b.pdf'])
    expect(readPanelGrid().status).toBe('pending')
    expect((await applyPanelGrid()).status).toBe('pending')
    expect(currentContentKey(useDocumentStore.getState())).toBe(before)
    expect(render).not.toHaveBeenCalled()
    preparePanelGrid()
    expect(render).toHaveBeenCalledExactlyOnceWith(panels()[1], 'immediate')
    expect(useDocumentStore.getState().past).toHaveLength(0)
  })

  it('image alignment can arrange known layout-only assets without a manifest', async () => {
    useRenderStore.getState().clear()
    useAssetStore.setState({ byId: Object.fromEntries(panels().map((p) => [p.fileId, {
      id: p.fileId, name: p.id, folder: '', kind: 'pdf' as const, native_w_mm: p.nativeW, native_h_mm: p.nativeH, mtime: 1,
      capability: { status: 'layout_only' as const, reason_code: 'no_source_candidate' as const, script: null, candidates: [], can_probe: false, can_manual_link: false },
    }])) })
    const before = currentContentKey(useDocumentStore.getState())
    expect((await applyPanelGrid({ basis: 'image' })).status).toBe('ready')
    expect(currentContentKey(useDocumentStore.getState())).not.toBe(before)
    expect(useDocumentStore.getState().doc.panelGrid?.basis).toBe('image')
    const [a, b, c] = panels()
    expect(a.x).toBeCloseTo(c.x)
    expect(a.y + a.h).toBeCloseTo(b.y + b.h)
    expect(engineRender).not.toHaveBeenCalled()
  })

  it('does not partially rearrange a canvas containing a locked panel', async () => {
    useDocumentStore.getState().commit(literal('lock'), (doc) => { doc.objects[1].locked = true })
    const before = currentContentKey(useDocumentStore.getState())
    const history = useDocumentStore.getState().past
    expect((await applyPanelGrid()).status).toBe('blocked')
    expect(currentContentKey(useDocumentStore.getState())).toBe(before)
    expect(useDocumentStore.getState().past).toBe(history)
  })

  it('settles an active input before creating the separate layout history step and enables grid', async () => {
    useUiStore.getState().setShowGrid(false)
    useDocumentStore.getState().beginTxn(literal('input'))
    useDocumentStore.getState().txnUpdate((doc) => { doc.objects[0].name = 'edited' })
    await applyPanelGrid()
    expect(useDocumentStore.getState().txn).toBeNull()
    expect(useDocumentStore.getState().past).toHaveLength(2)
    expect(useUiStore.getState().showGrid).toBe(true)
  })
})
