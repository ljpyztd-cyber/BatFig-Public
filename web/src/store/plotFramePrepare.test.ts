import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { literal } from '@/i18n'
import type { EngineRenderResponse, Manifest } from '@/lib/api'
import { currentContentKey } from '@/lib/documentCheckpoint'
import { normalizePanelGridSettings } from '@/lib/panelGrid'
import { planPlotFrame } from '@/lib/plotFrameLayout'
import { seedExactRender } from '@/test/renderFixtures'
import { emptyProject, type PanelObject, type PanelOverride } from '@/types/document'
import { useDocumentStore } from './documentStore'
import { preparePlotFramePanels, type PreparedPlotFrames } from './plotFramePrepare'
import { exactPanelManifest, useRenderStore } from './renderStore'

const engineRender = vi.fn()
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  engineRender: (...args: unknown[]) => engineRender(...args),
}))

const panel = (id: string): PanelObject => ({
  id, type: 'panel', fileId: `${id}.pdf`, fileKind: 'pdf', script: `${id}.py`,
  x: 0, y: 0, w: 100, h: 80, nativeW: 100, nativeH: 80, overrides: [],
})
const manifest = (square = false): Manifest => ({
  stem: 'plot-frame', size_mm: [100, 80], elements: [{
    gid: 'axes_0', role: 'axes', label: 'plot', identity: 'l1:plot', draggable: true, resizable: true,
    bbox: [0.1, 0.1, square ? 0.64 : 0.8, 0.8],
    editable: [
      { prop: 'position', type: 'rect', value: [0.1, 0.1, square ? 0.64 : 0.8, 0.8] },
      { prop: 'aspect', type: 'text', value: 'auto' },
    ],
  }],
})
const response = (square = true): EngineRenderResponse => ({ rev: 2, manifest: manifest(square), svg: '<svg/>', warnings: [] })
const renderedPositions = (_id: string, overrides: PanelOverride[]): EngineRenderResponse => {
  const result = response(false)
  const position = overrides.findLast((override) => override.gid === 'axes_0' && override.prop === 'position')?.value as number[] | undefined
  if (position) {
    const [x, y, w, h] = position
    result.manifest.elements[0].bbox = [x, 1 - y - h, w, h]
    result.manifest.elements[0].editable[0].value = position
  }
  return result
}
const fontPaddingResponse = (id: string, overrides: PanelOverride[], keepOutside = false): EngineRenderResponse => {
  const result = renderedPositions(id, overrides)
  const position = result.manifest.elements[0].editable[0].value as number[]
  const font = overrides.findLast((override) => override.gid === 'axes_0.ylabel' && override.prop === 'fontsize')?.value
  // The source label fits at 6 pt. At the requested size it needs more left
  // margin; the renderer's measured glyph bounds follow an applied position.
  result.manifest.elements.push({
    gid: 'axes_0.ylabel', role: 'axis_label', label: 'Y', identity: 'l1:ylabel', draggable: true,
    bbox: [keepOutside ? -0.03 : position[0] - (font ? 0.13 : 0.08), 0.35, 0.03, 0.3],
    editable: [{ prop: 'fontsize', type: 'number', value: font ?? 6, min: 1, max: 400 }],
  })
  return result
}
const applyPrepared = (prepared: PreparedPlotFrames, ratio: number) => {
  useDocumentStore.getState().commit(literal('apply prepared grid'), (draft) => {
    draft.panelGrid = { ...normalizePanelGridSettings({ ratio }), frames: prepared.frames }
    for (const panel of prepared.panels) (draft.objects.find((object) => object.id === panel.id) as PanelObject).overrides = panel.overrides
  })
}
const deferred = () => {
  let resolve!: (value: EngineRenderResponse) => void
  const promise = new Promise<EngineRenderResponse>((done) => { resolve = done })
  return { promise, resolve }
}
const doc = () => useDocumentStore.getState().doc
const setup = (count = 1) => {
  useDocumentStore.getState().commit(literal('fixture'), (draft) => {
    draft.objects = Array.from({ length: count }, (_, index) => panel(String(index)))
  })
  for (const object of doc().objects as PanelObject[]) seedExactRender(object, manifest())
  useDocumentStore.setState({ past: [], future: [] })
}

beforeEach(async () => {
  engineRender.mockReset()
  useRenderStore.getState().clear()
  await useDocumentStore.getState().switchDocument(emptyProject(), 'plot-frame-prepare')
  setup()
  engineRender.mockResolvedValue(response())
})
afterEach(() => vi.restoreAllMocks())

describe('plot-frame preparation transaction', () => {
  it('pre-renders stamped candidates without changing document content, history or native dimensions', async () => {
    const before = currentContentKey(useDocumentStore.getState())
    const prepared = await preparePlotFramePanels(doc(), 1)
    expect(prepared.status).toBe('ready')
    if (prepared.status !== 'ready') return
    expect(prepared.panels[0].overrides[0]).toMatchObject({ gid: 'axes_0', prop: 'position', identity: 'l1:plot' })
    expect(prepared.panels[0]).toMatchObject({ nativeW: 100, nativeH: 80, w: 100, h: 80 })
    expect(prepared.manifests.get('0')).toEqual(manifest(true))
    expect(exactPanelManifest(useRenderStore.getState(), prepared.panels[0])).toEqual(manifest(true))
    expect(prepared.isCurrent()).toBe(true)
    expect(currentContentKey(useDocumentStore.getState())).toBe(before)
    expect(useDocumentStore.getState().past).toHaveLength(0)
  })

  it('refuses missing exact geometry rather than using latest display fallback', async () => {
    useDocumentStore.getState().commit(literal('new variant'), (draft) => {
      (draft.objects[0] as PanelObject).overrides.push({ gid: 'axes_0', prop: 'title', value: 'new' })
    })
    expect(await preparePlotFramePanels(doc(), 1)).toMatchObject({ status: 'error', code: 'geometry_pending' })
    expect(engineRender).not.toHaveBeenCalled()
  })

  it('reuses exact no-op geometry without rendering or adding overrides', async () => {
    const p = doc().objects[0] as PanelObject
    seedExactRender(p, manifest(true))
    const prepared = await preparePlotFramePanels(doc(), 1)
    expect(prepared.status).toBe('ready')
    if (prepared.status !== 'ready') return
    expect(prepared.panels[0].overrides).toEqual([])
    expect(prepared.manifests.get(p.id)).toEqual(manifest(true))
    expect(engineRender).not.toHaveBeenCalled()
  })

  it('restores the first frame after 4:3 to 1:1 to 4:3, including an uncached baseline', async () => {
    engineRender.mockImplementation(renderedPositions)
    const first = await preparePlotFramePanels(doc(), 4 / 3)
    expect(first.status).toBe('ready')
    if (first.status !== 'ready') return
    applyPrepared(first, 4 / 3)
    const square = await preparePlotFramePanels(doc(), 1)
    expect(square.status).toBe('ready')
    if (square.status !== 'ready') return
    applyPrepared(square, 1)
    expect(square.frames['0'].baselineOverrides).toEqual([])
    // Baselines are durable overrides, not a persisted/fabricated manifest.
    useRenderStore.getState().clear()
    const current = doc().objects[0] as PanelObject
    seedExactRender(current, renderedPositions(current.fileId, current.overrides).manifest)
    engineRender.mockClear()
    const restored = await preparePlotFramePanels(doc(), 4 / 3)
    expect(restored.status).toBe('ready')
    if (restored.status !== 'ready') return
    expect(engineRender).toHaveBeenCalledTimes(2)
    expect(engineRender.mock.calls[0][1]).toEqual([])
    expect(restored.panels[0].overrides).toEqual(first.panels[0].overrides)
    expect(restored.manifests.get('0')?.elements[0].bbox).toEqual(first.manifests.get('0')?.elements[0].bbox)
    applyPrepared(restored, 4 / 3)
    useRenderStore.getState().clear()
    seedExactRender(doc().objects[0] as PanelObject, restored.manifests.get('0')!)
    engineRender.mockClear()
    // A reopened cache contains only the current variant. A canvas resize also
    // does not redefine the native plotting frame baseline.
    useDocumentStore.getState().commit(literal('move and scale panel'), (draft) => {
      Object.assign(draft.objects[0], { x: 45, y: 20, w: 50, h: 40 })
    })
    const repeated = await preparePlotFramePanels(doc(), 4 / 3)
    expect(repeated.status).toBe('ready')
    if (repeated.status !== 'ready') return
    expect(repeated.frames).toEqual(restored.frames)
    expect(engineRender).not.toHaveBeenCalled()
  })

  it('replaces the baseline after a manual in-figure edit rather than undoing that edit', async () => {
    engineRender.mockImplementation(renderedPositions)
    const first = await preparePlotFramePanels(doc(), 1)
    expect(first.status).toBe('ready')
    if (first.status !== 'ready') return
    applyPrepared(first, 1)
    useDocumentStore.getState().commit(literal('manual frame and style'), (draft) => {
      const p = draft.objects[0] as PanelObject
      p.overrides = [
        { gid: 'axes_0', prop: 'position', value: [0.2, 0.2, 0.5, 0.5] },
        { gid: 'axes_0', prop: 'facecolor', value: '#abcabc' },
      ]
    })
    const current = doc().objects[0] as PanelObject
    seedExactRender(current, renderedPositions(current.fileId, current.overrides).manifest)
    const next = await preparePlotFramePanels(doc(), 4 / 3)
    expect(next.status).toBe('ready')
    if (next.status !== 'ready') return
    expect(next.frames['0'].baselineOverrides).toEqual(current.overrides)
    expect(next.panels[0].overrides).toContainEqual(current.overrides[1])
    expect(next.panels[0].overrides[0].value).toEqual([0.2, 0.2, 0.5, 0.4688])
  })

  it('discards a malformed persisted baseline before it can reach the renderer', async () => {
    engineRender.mockImplementation(renderedPositions)
    const first = await preparePlotFramePanels(doc(), 1)
    expect(first.status).toBe('ready')
    if (first.status !== 'ready') return
    applyPrepared(first, 1)
    useDocumentStore.getState().commit(literal('malformed imported baseline'), (draft) => {
      draft.panelGrid!.frames!['0'].baselineOverrides = [{ gid: '', prop: 'position', value: [0.1, 0.1, 0.2, 0.2] }]
    })
    const current = doc().objects[0] as PanelObject
    engineRender.mockClear()
    const next = await preparePlotFramePanels(doc(), 4 / 3)
    expect(next.status).toBe('ready')
    if (next.status !== 'ready') return
    expect(next.frames['0'].baselineOverrides).toEqual(current.overrides)
    expect(engineRender).toHaveBeenCalledOnce()
    expect((engineRender.mock.calls[0][1] as PanelOverride[]).every((override) => override.gid.length > 0)).toBe(true)
  })

  it.each(['ratio', 'figure-size', 'warnings'] as const)('rejects a real response that violates %s', async (mode) => {
    const res = response(mode !== 'ratio')
    if (mode === 'figure-size') res.manifest.size_mm = [101, 80]
    if (mode === 'warnings') res.warnings = ['position rejected']
    engineRender.mockResolvedValue(res)
    const before = currentContentKey(useDocumentStore.getState())
    expect(await preparePlotFramePanels(doc(), 1)).toMatchObject({ status: 'error', code: mode === 'warnings' ? 'render_failed' : 'geometry_mismatch' })
    expect(currentContentKey(useDocumentStore.getState())).toBe(before)
  })

  it.each(['edit-revert', 'transaction', 'load', 'canvas', 'project'] as const)('invalidates preparation on an intervening %s', async (mode) => {
    const pending = deferred()
    engineRender.mockReturnValue(pending.promise)
    const preparing = preparePlotFramePanels(doc(), 1)
    await vi.waitFor(() => expect(engineRender).toHaveBeenCalledOnce())
    const store = useDocumentStore.getState()
    if (mode === 'edit-revert') {
      store.commit(literal('user edit'), (draft) => { draft.name = 'changed' })
      useDocumentStore.getState().undo()
    } else if (mode === 'transaction') {
      store.beginTxn(literal('new gesture'))
      useDocumentStore.getState().endTxn()
    } else if (mode === 'load') useDocumentStore.setState({ loadSeq: store.loadSeq + 1 })
    else if (mode === 'canvas') useDocumentStore.setState({ activeCanvasId: 'other-canvas' })
    else useRenderStore.getState().clear()
    expect(await preparing).toMatchObject({ status: 'error', code: 'changed' })
    pending.resolve(response())
    await Promise.resolve()
  })

  it('waits for the exact busy variant instead of accepting render() early return', async () => {
    // A first request is already in progress for the candidate without identity.
    // A no-identity fixture ensures it is exactly the helper's key as well.
    const p = doc().objects[0] as PanelObject
    const m = manifest()
    delete m.elements[0].identity
    seedExactRender(p, m)
    const candidate = planPlotFrame(p, m, 1)
    const pending = deferred()
    engineRender.mockReturnValue(pending.promise)
    const existing = useRenderStore.getState().render(p.fileId, candidate.overrides)
    let finished = false
    const preparing = preparePlotFramePanels(doc(), 1).then((value) => { finished = true; return value })
    await Promise.resolve()
    expect(finished).toBe(false)
    pending.resolve(response())
    expect((await preparing).status).toBe('ready')
    await existing
  })

  it('limits actual concurrent requests to two for a larger grid', async () => {
    setup(4)
    const calls = Array.from({ length: 4 }, deferred)
    let index = 0
    engineRender.mockImplementation(() => calls[index++].promise)
    const preparing = preparePlotFramePanels(doc(), 1)
    await vi.waitFor(() => expect(engineRender).toHaveBeenCalledTimes(2))
    calls[0].resolve(response())
    await vi.waitFor(() => expect(engineRender).toHaveBeenCalledTimes(3))
    calls[1].resolve(response())
    await vi.waitFor(() => expect(engineRender).toHaveBeenCalledTimes(4))
    calls[2].resolve(response())
    calls[3].resolve(response())
    expect((await preparing).status).toBe('ready')
  })

  it('cancels when a completed candidate becomes stale while another is pending, even if refreshed again', async () => {
    setup(2)
    const before = currentContentKey(useDocumentStore.getState())
    const calls = [deferred(), deferred()]
    let index = 0
    engineRender.mockImplementation(() => calls[index++].promise)
    const preparing = preparePlotFramePanels(doc(), 1)
    await vi.waitFor(() => expect(engineRender).toHaveBeenCalledTimes(2))
    const completed = response()
    calls[0].resolve(completed)
    const first = doc().objects[0] as PanelObject
    const candidate = { ...first, overrides: engineRender.mock.calls[0][1] as PanelOverride[] }
    await vi.waitFor(() => expect(exactPanelManifest(useRenderStore.getState(), candidate)).toBe(completed.manifest))
    useRenderStore.getState().markStale([first.fileId])
    // Even restoring this same manifest reference cannot revive the stale plan.
    seedExactRender(candidate, completed.manifest)
    calls[1].resolve(response())
    expect(await preparing).toMatchObject({ status: 'error', code: 'changed' })
    expect(currentContentKey(useDocumentStore.getState())).toBe(before)
    expect(useDocumentStore.getState().past).toHaveLength(0)
  })

  it('rechecks retained exact geometry in the final commit guard after preparation returns', async () => {
    const prepared = await preparePlotFramePanels(doc(), 1)
    expect(prepared.status).toBe('ready')
    if (prepared.status !== 'ready') return
    useRenderStore.getState().reset(prepared.panels[0].fileId)
    expect(prepared.isCurrent()).toBe(false)
  })

  it('renders measured font overflow and its padding before returning ready, without padding the source baseline', async () => {
    useDocumentStore.getState().commit(literal('fit source page'), (draft) => {
      draft.page.w = 100
      draft.page.h = 80
    })
    useDocumentStore.setState({ past: [], future: [] })
    const original = doc().objects[0] as PanelObject
    seedExactRender(original, fontPaddingResponse(original.fileId, original.overrides).manifest)
    engineRender.mockImplementation((id: string, overrides: PanelOverride[]) => fontPaddingResponse(id, overrides))
    const before = currentContentKey(useDocumentStore.getState())
    const settings = normalizePanelGridSettings({ ratio: 1.25, margin: 0, axisFontSizePt: 8 })
    const prepared = await preparePlotFramePanels(doc(), settings.ratio, settings)
    expect(prepared.status).toBe('ready')
    if (prepared.status !== 'ready') return
    expect(engineRender).toHaveBeenCalledTimes(2)
    const firstRender = engineRender.mock.calls[0][1] as PanelOverride[]
    expect(firstRender).toContainEqual(expect.objectContaining({ gid: 'axes_0.ylabel', prop: 'fontsize', value: 8 }))
    expect(firstRender.some((override) => override.prop === 'position')).toBe(false)
    expect(prepared.panels[0].overrides).toContainEqual(expect.objectContaining({ gid: 'axes_0', prop: 'position' }))
    const measuredLabel = prepared.manifests.get(original.id)!.elements.find((element) => element.gid === 'axes_0.ylabel')!
    expect(measuredLabel.bbox[0]).toBeGreaterThanOrEqual(0)
    expect(measuredLabel.bbox[0] + measuredLabel.bbox[2]).toBeLessThanOrEqual(1)
    expect(prepared.frames[original.id].baselineOverrides).toContainEqual(expect.objectContaining({ prop: 'fontsize', value: 8 }))
    expect(prepared.frames[original.id].baselineOverrides.some((override) => override.prop === 'position')).toBe(false)
    expect(currentContentKey(useDocumentStore.getState())).toBe(before)
    expect(useDocumentStore.getState().past).toHaveLength(0)
  })

  it('rejects a renderer that keeps axis text outside the figure after padding without changing the document', async () => {
    useDocumentStore.getState().commit(literal('fit source page'), (draft) => {
      draft.page.w = 100
      draft.page.h = 80
    })
    useDocumentStore.setState({ past: [], future: [] })
    const original = doc().objects[0] as PanelObject
    seedExactRender(original, fontPaddingResponse(original.fileId, original.overrides).manifest)
    engineRender.mockImplementation((id: string, overrides: PanelOverride[]) => fontPaddingResponse(id, overrides, true))
    const before = currentContentKey(useDocumentStore.getState())
    const settings = normalizePanelGridSettings({ ratio: 1.25, margin: 0, axisFontSizePt: 8 })
    expect(await preparePlotFramePanels(doc(), settings.ratio, settings)).toMatchObject({ status: 'error', code: 'font_layout_failed' })
    expect(engineRender.mock.calls.some((call) => (call[1] as PanelOverride[]).some((override) => override.prop === 'position'))).toBe(true)
    expect(currentContentKey(useDocumentStore.getState())).toBe(before)
    expect(useDocumentStore.getState().past).toHaveLength(0)
  })

  it('invalidates a pending font render after the document changes without applying candidate overrides', async () => {
    useDocumentStore.getState().commit(literal('fit source page'), (draft) => {
      draft.page.w = 100
      draft.page.h = 80
    })
    useDocumentStore.setState({ past: [], future: [] })
    const original = doc().objects[0] as PanelObject
    seedExactRender(original, fontPaddingResponse(original.fileId, original.overrides).manifest)
    const pending = deferred()
    engineRender.mockReturnValue(pending.promise)
    const settings = normalizePanelGridSettings({ ratio: 1.25, margin: 0, axisFontSizePt: 8 })
    const preparing = preparePlotFramePanels(doc(), settings.ratio, settings)
    await vi.waitFor(() => expect(engineRender).toHaveBeenCalledOnce())
    expect(engineRender.mock.calls[0][1]).toContainEqual(expect.objectContaining({ prop: 'fontsize', value: 8 }))
    useDocumentStore.getState().commit(literal('user edit during font rendering'), (draft) => { draft.name = 'edited meanwhile' })
    expect(await preparing).toMatchObject({ status: 'error', code: 'changed' })
    const candidateOverrides = engineRender.mock.calls[0][1] as PanelOverride[]
    pending.resolve(fontPaddingResponse(original.fileId, candidateOverrides))
    await Promise.resolve()
    expect(doc().name).toBe('edited meanwhile')
    expect((doc().objects[0] as PanelObject).overrides).toEqual(original.overrides)
    expect(useDocumentStore.getState().past).toHaveLength(1)
  })
})
