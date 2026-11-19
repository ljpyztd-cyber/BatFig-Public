import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { literal } from '@/i18n'
import type { Manifest, ManifestElement } from '@/lib/api'
import { panelAxesBounds } from '@/lib/canvasAlignment'
import { seedExactRender } from '@/test/renderFixtures'
import { emptyProject, type PanelObject } from '@/types/document'
import { alignSelectedTo } from './actions'
import { useArrangeStore } from './arrangeStore'
import { useDocumentStore } from './documentStore'
import { renderKeyOf, useRenderStore } from './renderStore'
import * as scheduler from './renderScheduler'
import { prepareCanvasAlignment, readCanvasAlignment } from './canvasAlignment'
import { useSelectionStore } from './selectionStore'
import { useUiStore } from './uiStore'

const makePanel = (id: string, x: number, y: number): PanelObject => ({
  id, type: 'panel', fileId: `${id}.pdf`, fileKind: 'pdf', name: id,
  nativeW: 100, nativeH: 50, x, y, w: 100, h: 50, overrides: [],
})
const makeManifest = (bbox: ManifestElement['bbox']): Manifest => ({
  stem: 'alignment-fixture', size_mm: [100, 50], elements: [{ gid: 'axes_0', role: 'axes', label: 'axes', bbox, editable: [], draggable: true }],
})
const obj = (id: string) => useDocumentStore.getState().doc.objects.find((o) => o.id === id)! as PanelObject
const past = () => useDocumentStore.getState().past
const first = makeManifest([0.1, 0.1, 0.6, 0.7])
const second = makeManifest([0.2, 0.2, 0.5, 0.6])

beforeEach(async () => {
  useArrangeStore.setState({ alignBasis: 'axes', alignRef: 'selection' })
  useRenderStore.getState().clear()
  await useDocumentStore.getState().switchDocument(emptyProject(), 'axes-align')
  useDocumentStore.getState().commit(literal('setup'), (d) => { d.objects = [makePanel('a', 0, 0), makePanel('b', 120, 60)] })
  useDocumentStore.setState({ past: [], future: [] })
  useSelectionStore.getState().set(['a', 'b'])
  seedExactRender(obj('a'), first)
  seedExactRender(obj('b'), second)
})
afterEach(() => vi.restoreAllMocks())

describe('axes alignment action', () => {
  it('aligns axes despite unequal margins, with one undoable change and no overrides', () => {
    alignSelectedTo('left', 'selection')
    expect(obj('a').x).toBe(0)
    expect(obj('b').x).toBe(-10)
    expect(panelAxesBounds(obj('a'), first)!.x).toBe(panelAxesBounds(obj('b'), second)!.x)
    expect(obj('b').overrides).toEqual([])
    expect(past()).toHaveLength(1)
    useDocumentStore.getState().undo()
    expect(obj('b').x).toBe(120)
    useDocumentStore.getState().redo()
    expect(obj('b').x).toBe(-10)
    alignSelectedTo('left', 'selection')
    expect(past()).toHaveLength(1)
  })

  it('aligns bottom axes to the primary panel; image mode retains outer-bound alignment', () => {
    alignSelectedTo('bottom', 'primary')
    expect(panelAxesBounds(obj('a'), first)!.y + panelAxesBounds(obj('a'), first)!.h).toBeCloseTo(100)
    expect(obj('b').y).toBe(60)
    useArrangeStore.getState().setAlignBasis('image')
    alignSelectedTo('left', 'selection')
    expect(obj('a').x).toBe(obj('b').x)
  })

  it('rejects an entire selection if one variant is stale, leaving both positions and history unchanged', () => {
    useRenderStore.getState().markStale(['b.pdf'])
    alignSelectedTo('left', 'selection')
    expect(obj('b').x).toBe(120)
    expect(past()).toHaveLength(0)
    expect(useUiStore.getState().status?.key).toBe('status.alignAxesSyncing')
  })

  it('does not use a different variant of the same file as geometric authority', () => {
    useDocumentStore.getState().commit(literal('variant'), (d) => {
      const b = d.objects[1] as PanelObject
      b.overrides = [{ gid: 'axes_0', prop: 'position', value: [0.3, 0.2, 0.5, 0.6] }]
    })
    const before = past().length
    alignSelectedTo('top', 'selection')
    expect(obj('b').y).toBe(60)
    expect(past()).toHaveLength(before)
  })

  it('size matching remains available without axes geometry and retains image aspect ratio', () => {
    useRenderStore.getState().clear()
    useDocumentStore.getState().commit(literal('size'), (d) => { d.objects[1].w = 80 })
    alignSelectedTo('samew', 'primary')
    expect(obj('a').w).toBe(80)
    expect(obj('a').h).toBe(40)
  })

  it('reading state never runs scripts; explicit preparation skips exact or already-rendering variants', () => {
    const render = vi.spyOn(scheduler, 'requestRender').mockImplementation(() => {})
    useRenderStore.getState().clear()
    expect(readCanvasAlignment([obj('a'), obj('b')], 'axes').pending).toBe(true)
    expect(render).not.toHaveBeenCalled()
    seedExactRender(obj('a'), first)
    prepareCanvasAlignment()
    expect(render).toHaveBeenCalledExactlyOnceWith(obj('b'), 'immediate')
    render.mockClear()
    useRenderStore.getState().patch(renderKeyOf(obj('b')), { status: 'rendering' })
    prepareCanvasAlignment()
    expect(render).not.toHaveBeenCalled()
  })

  it('distributes plotting areas using equal gaps and preserves the outside anchors', () => {
    useDocumentStore.getState().commit(literal('third'), (d) => { d.objects.push(makePanel('c', 280, 0)) })
    const third = makeManifest([0.3, 0.1, 0.5, 0.7])
    seedExactRender(obj('c'), third)
    useSelectionStore.getState().set(['a', 'b', 'c'])
    alignSelectedTo('hdist', 'selection')
    const a = panelAxesBounds(obj('a'), first)!
    const b = panelAxesBounds(obj('b'), second)!
    const c = panelAxesBounds(obj('c'), third)!
    expect(b.x - a.x - a.w).toBeCloseTo(c.x - b.x - b.w)
    expect(a.x).toBe(10)
    expect(c.x + c.w).toBe(360)
  })

  it('locked plot stays fixed while its axes bound remains the selection reference', () => {
    useDocumentStore.getState().commit(literal('lock'), (d) => { d.objects[0].locked = true })
    alignSelectedTo('left', 'selection')
    expect(obj('a').x).toBe(0)
    expect(obj('b').x).toBe(-10)
  })
})
