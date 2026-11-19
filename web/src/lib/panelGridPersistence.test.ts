import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { literal } from '@/i18n'
import { useDocumentStore } from '@/store/documentStore'
import { canvasToDoc, docToCanvas, emptyDocument, emptyProject, migrateToProject, type FigureDocument, type PanelObject, type ProjectDocument } from '@/types/document'
import { currentContentKey, projectContentKey } from './documentCheckpoint'
import { normalizeLayout } from './migrate'
import type { PanelGridSettings } from './panelGrid'

const grid: PanelGridSettings = {
  cols: 2, ratio: 4 / 3, gap: 6, margin: 8, axisFontSizePt: 12, basis: 'axes',
  columnAlign: 'start', rowAlign: 'end', order: ['p2', 'p1'],
}
const panel = (id: string, hidden = false): PanelObject => ({
  id, type: 'panel', fileId: `${id}.pdf`, fileKind: 'pdf', nativeW: 40, nativeH: 30,
  x: 0, y: 0, w: 40, h: 30, overrides: [], hidden,
})
const documentWithGrid = (): FigureDocument => ({
  ...emptyDocument(), panelGrid: structuredClone(grid),
  objects: [panel('p1'), panel('p2'), {
    id: 'label', type: 'text', text: '(a)', panelLabelFor: 'p1', sizePt: 14,
    bold: true, color: '#000000', align: 'left', x: 1, y: 1, w: 5, h: 6,
  }],
})

describe('optional panel grid document fields', () => {
  it('round-trips grid order and label associations through schema 2/3 and canvas conversions', () => {
    const source = documentWithGrid()
    const normalized = normalizeLayout(JSON.parse(JSON.stringify(source)), 'loaded') as FigureDocument
    expect(normalized.panelGrid).toEqual(grid)
    const project = migrateToProject(normalized)!
    const reopened = normalizeLayout(JSON.parse(JSON.stringify(project)), 'loaded') as ProjectDocument
    const current = canvasToDoc(reopened.canvases[0])
    expect(current.panelGrid).toEqual(grid)
    expect(current.objects[2]).toEqual(source.objects[2])
    expect(docToCanvas(current, reopened.canvases[0].id)).toEqual(reopened.canvases[0])
  })

  it('normalizes present schema 2 settings using only visible panel count', () => {
    const current = normalizeLayout({
      ...documentWithGrid(), objects: [panel('p1'), panel('p2'), panel('hidden', true)],
      panelGrid: { cols: 99, ratio: -2, gap: -3, margin: -1, order: ['p2', '', 'p2', 3, 'p1'] },
    }, 'loaded') as FigureDocument
    expect(current.panelGrid).toEqual({ ...grid, gap: 0, margin: 0, axisFontSizePt: 8 })
  })

  it.each([undefined, null, 'grid', [], 5])('does not introduce a grid for absent/invalid shape %s', (value) => {
    const current = normalizeLayout({ ...emptyDocument(), panelGrid: value }, 'old') as FigureDocument
    expect(current).not.toHaveProperty('panelGrid')
    expect(migrateToProject(current)!.canvases[0]).not.toHaveProperty('panelGrid')
  })

  it('content checkpoints detect settings and label bindings, but ignore the active tab', () => {
    const project = migrateToProject(documentWithGrid())!
    const key = projectContentKey(project)
    const changed = structuredClone(project)
    changed.canvases[0].panelGrid!.ratio = 1
    expect(projectContentKey(changed)).not.toBe(key)
    changed.canvases[0].panelGrid = structuredClone(grid)
    const text = changed.canvases[0].objects[2]
    if (text.type === 'text') text.panelLabelFor = 'p2'
    expect(projectContentKey(changed)).not.toBe(key)
    expect(projectContentKey({ ...project, activeCanvasId: 'other' })).toBe(key)
  })
})

describe('panel grid multi-canvas persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === 'PUT'
      ? new Response(JSON.stringify({ ok: true, saved_at: 1, revision: 'grid-r1' }), { status: 200 })
      : new Response('{}', { status: 404 })))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('remaps the grid order and label associations when a canvas is duplicated', async () => {
    const project = migrateToProject(documentWithGrid())!
    const s = () => useDocumentStore.getState()
    await s().switchDocument(project, 'grid-to-duplicate')
    const id = s().duplicateCanvas(s().activeCanvasId)!
    const copied = s().canvases.find((canvas) => canvas.id === id)!
    const copiedPanels = copied.objects.filter((object): object is PanelObject => object.type === 'panel')
    const first = copiedPanels.find((object) => object.fileId === 'p1.pdf')!
    const second = copiedPanels.find((object) => object.fileId === 'p2.pdf')!
    expect(copied.panelGrid).toEqual({ ...grid, order: [second.id, first.id] })
    expect(copied.objects.find((object) => object.type === 'text')).toMatchObject({ panelLabelFor: first.id })
    expect(first.id).not.toBe('p1')
    expect(s().doc.panelGrid).toEqual(grid)
    expect(s().doc.objects[2]).toMatchObject({ panelLabelFor: 'p1' })
  })

  it('does not turn stale or non-panel references into copied object associations', async () => {
    const source = documentWithGrid()
    source.panelGrid!.order = ['p2', 'label', 'missing', 'p1']
    const label = source.objects[2]
    if (label.type === 'text') label.panelLabelFor = 'label'
    const project = migrateToProject(source)!
    const s = () => useDocumentStore.getState()
    await s().switchDocument(project, 'grid-bad-references')
    const id = s().duplicateCanvas(s().activeCanvasId)!
    const copied = s().canvases.find((canvas) => canvas.id === id)!
    const panels = copied.objects.filter((object): object is PanelObject => object.type === 'panel')
    expect(copied.panelGrid!.order).toEqual([
      panels.find((panel) => panel.fileId === 'p2.pdf')!.id,
      panels.find((panel) => panel.fileId === 'p1.pdf')!.id,
    ])
    expect(copied.objects.find((object) => object.type === 'text')).not.toHaveProperty('panelLabelFor')
    expect(s().doc.objects[2]).toMatchObject({ panelLabelFor: 'label' })
  })

  it('retains each canvas grid through switching, a saved snapshot and reopen; edits remain undoable', async () => {
    const project = migrateToProject(documentWithGrid())!
    const first = project.canvases[0].id
    project.canvases.push({ ...docToCanvas(emptyDocument(), 'second'), name: 'Second', panelGrid: { ...grid, cols: 1, ratio: 1, order: [] } })
    const s = () => useDocumentStore.getState()
    await s().switchDocument(project, 'grid-document')
    s().commit(literal('edit grid'), (doc) => { doc.panelGrid!.gap = 10 })
    const changedKey = currentContentKey(s())
    s().switchCanvas('second')
    expect(s().doc.panelGrid).toMatchObject({ cols: 1, ratio: 1 })
    expect(currentContentKey(s())).toBe(changedKey)
    s().switchCanvas(first)
    expect(s().doc.panelGrid!.gap).toBe(10)
    s().undo()
    expect(s().doc.panelGrid).toEqual(grid)
    s().redo()
    expect(s().doc.panelGrid!.gap).toBe(10)
    const saved = JSON.stringify(s().buildProject())
    await s().switchDocument(emptyProject(), 'blank-document')
    await s().switchDocument(normalizeLayout(JSON.parse(saved), 'reopen'), 'grid-reopened')
    expect(s().doc.panelGrid!.gap).toBe(10)
    expect(currentContentKey(s())).toBe(changedKey)
    s().switchCanvas('second')
    expect(s().doc.panelGrid).toMatchObject({ cols: 1, ratio: 1, order: [] })
  })
})
