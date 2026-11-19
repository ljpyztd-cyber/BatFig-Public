import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { literal } from '@/i18n'
import { canvasToDoc, emptyProject, type PanelObject, type ProjectDocument } from '@/types/document'
import { applyDerivedUpdate, flushAutosave, registerTxnFinalizer, restoreSession, saveNow, startAutosave, useDocumentStore } from '@/store/documentStore'
import { openRecentDocument } from '@/store/actions'
import { ApiError, fetchLayout, saveLayout } from '@/lib/api'
import { currentProjectId, setCurrentProjectId } from '@/lib/session'
import { forgetLayoutRevisions, knownLayoutRevision } from '@/lib/layoutRevision'
import { rememberProjectDocument } from '@/lib/projectDocs'
import { projectContentKey } from './documentCheckpoint'
import { bindNamedDocumentTarget, getDocumentSaveStatus, hasPendingCanvasChanges, hasPendingDocumentChanges, restoreNamedSaveContext, saveCurrentDocument, saveDocumentAs } from './namedSave'

vi.mock('@/lib/api', async (original) => ({
  ...await original<typeof import('@/lib/api')>(),
  saveLayout: vi.fn(),
  fetchLayout: vi.fn(),
}))

const s = () => useDocumentStore.getState()
const save = vi.mocked(saveLayout)
const load = vi.mocked(fetchLayout)
const written = () => save.mock.lastCall?.[1] as ProjectDocument
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const panel: PanelObject = { id: 'panel', type: 'panel', fileId: 'a.pdf', fileKind: 'pdf', script: 'a.py', overrides: [], nativeW: 80, nativeH: 60, x: 0, y: 0, w: 80, h: 60 }

function install(project = emptyProject(), id = 'document') {
  useDocumentStore.setState({
    doc: canvasToDoc(project.canvases[0]), canvases: project.canvases,
    documentId: id, projectMeta: { ...project.project, createdAt: project.createdAt },
    activeCanvasId: project.canvases[0].id, canvasSessions: {}, openTabs: [project.canvases[0].id],
    loadSeq: s().loadSeq + 1, past: [], future: [], txn: null,
    namedTarget: null, savedCheckpoint: projectContentKey(project), namedSaveState: 'idle', namedSaveIssue: null, namedSavedAt: null,
    dirty: false, saveState: 'clean', saveIssue: null,
  })
}

function edit(width: number) { s().commit(literal('width'), (doc) => { doc.page.w = width }) }
function bind() { bindNamedDocumentTarget({ name: 'paper', revision: 'r1' }) }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  localStorage.clear()
  forgetLayoutRevisions()
  setCurrentProjectId('project-a')
  install()
  save.mockReset().mockResolvedValue({ ok: true, revision: 'r2' })
  load.mockReset()
  vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => init?.method === 'PUT'
    ? new Response(JSON.stringify({ ok: true, saved_at: 1, revision: 'draft-r' }), { status: 200 })
    : new Response('{}', { status: 404 })))
})
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('formal named-file checkpoint', () => {
  it('startup restores only the current project mapping, never another tab\'s global pointer', async () => {
    const saved = emptyProject()
    saved.canvases[0].page.w = 163
    localStorage.setItem('tavotto.currentDoc', 'foreign-document')
    rememberProjectDocument('project-a', { id: 'own-document', name: 'Own' })
    const fetcher = vi.fn(async (_url: unknown) => new Response(JSON.stringify(saved), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    expect(await restoreSession()).toBe(true)
    expect(s().documentId).toBe('own-document')
    expect(s().doc.page.w).toBe(163)
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/api/autosave/own-document?pj=project-a')
  })

  it('a project without its own recovery mapping does not read the global foreign document', async () => {
    localStorage.setItem('tavotto.currentDoc', 'foreign-document')
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    expect(await restoreSession()).toBe(false)
    expect(s().documentId).toBe('document')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('startup recovery in flight cannot move a document into a different project', async () => {
    rememberProjectDocument('project-a', { id: 'own-document', name: 'Own' })
    const gate = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => gate.promise))
    const promise = restoreSession()
    await tick()
    setCurrentProjectId('project-b')
    gate.resolve(new Response(JSON.stringify(emptyProject()), { status: 200 }))
    expect(await promise).toBe(false)
    expect(s().documentId).toBe('document')
  })

  it('opening a recent document cannot erase an edit made while its read is pending', async () => {
    const gate = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => gate.promise))
    const promise = openRecentDocument('recent-document')
    await tick()
    edit(164)
    gate.resolve(new Response(JSON.stringify(emptyProject()), { status: 200 }))
    expect(await promise).toBe(false)
    expect(s().documentId).toBe('document')
    expect(s().doc.page.w).toBe(164)
  })

  it('asks for a name once, then writes the same project file with a revision baseline', async () => {
    edit(130)
    expect(await saveCurrentDocument()).toEqual({ status: 'needs_name' })
    expect(save).not.toHaveBeenCalled()
    expect(await saveDocumentAs('paper')).toEqual({ status: 'saved' })
    expect(save.mock.calls[0][2]).toBe('absent')
    expect(s().namedTarget?.name).toBe('paper')
    edit(140)
    expect(await saveCurrentDocument()).toEqual({ status: 'saved' })
    expect(save.mock.lastCall?.[0]).toBe('paper')
    expect(save.mock.lastCall?.slice(2)).toEqual(['r2', 'project-a'])
  })

  it('undo to saved content is clean and redo is dirty, independent of history position', async () => {
    bind()
    const width = s().doc.page.w
    edit(width + 1)
    expect(hasPendingDocumentChanges()).toBe(true)
    s().undo()
    expect(getDocumentSaveStatus(s())).toBe('clean')
    s().redo()
    expect(hasPendingDocumentChanges()).toBe(true)
    for (let i = 0; i < 210; i++) edit(width + 10 + i)
    edit(width)
    expect(s().past).toHaveLength(200)
    expect(hasPendingDocumentChanges()).toBe(false)
  })

  it('a recovery autosave never advances the formal-file checkpoint', async () => {
    s().commit(literal('panel'), (doc) => { doc.objects.push({ ...panel }) })
    bind()
    edit(s().doc.page.w + 4)
    flushAutosave()
    await saveNow()
    expect(s().saveState).toBe('saved')
    expect(hasPendingDocumentChanges()).toBe(true)
    expect(save).not.toHaveBeenCalled()
  })

  it('an old save receipt cannot mark newer edits clean; undo reaches the saved snapshot', async () => {
    bind()
    edit(121)
    const gate = deferred<{ ok: boolean; revision: string }>()
    save.mockReturnValueOnce(gate.promise)
    const promise = saveCurrentDocument()
    await tick()
    edit(122)
    gate.resolve({ ok: true, revision: 'saved-121' })
    expect(await promise).toEqual({ status: 'stale' })
    expect(hasPendingDocumentChanges()).toBe(true)
    expect(written().canvases[0].page.w).toBe(121)
    s().undo()
    expect(hasPendingDocumentChanges()).toBe(false)
    expect(s().namedTarget?.revision).toBe('saved-121')
  })

  it('a late acknowledgement stays with its captured project and cannot alter another document', async () => {
    bind()
    edit(131)
    const gate = deferred<{ ok: boolean; revision: string }>()
    save.mockReturnValueOnce(gate.promise)
    const promise = saveCurrentDocument()
    await tick()
    setCurrentProjectId('project-b')
    install(emptyProject(), 'other')
    gate.resolve({ ok: true, revision: 'old-result' })
    expect(await promise).toEqual({ status: 'stale' })
    expect(save.mock.lastCall?.[3]).toBe('project-a')
    expect(s().namedTarget).toBeNull()
    expect(s().namedSaveState).toBe('idle')
    expect(knownLayoutRevision('paper', 'project-a')).toBe('old-result')
    expect(knownLayoutRevision('paper', 'project-b')).toBeUndefined()
  })

  it('merges repeated saves while the same snapshot is in flight', async () => {
    bind()
    const gate = deferred<{ ok: boolean; revision: string }>()
    save.mockReturnValueOnce(gate.promise)
    const first = saveCurrentDocument()
    const second = saveCurrentDocument()
    await tick()
    expect(save).toHaveBeenCalledTimes(1)
    gate.resolve({ ok: true, revision: 'same' })
    expect((await Promise.all([first, second])).map((r) => r.status)).toEqual(['saved', 'saved'])
  })

  it('keeps a failed/conflicting save dirty and accepts only the explicit replacement revision', async () => {
    bind()
    const checkpoint = s().savedCheckpoint
    edit(145)
    const error = new ApiError('changed', 409, { code: 'external_change', revision: 'external-r' })
    save.mockRejectedValueOnce(error)
    expect((await saveCurrentDocument()).status).toBe('error')
    expect(s().savedCheckpoint).toBe(checkpoint)
    expect(s().namedSaveState).toBe('conflict')
    expect(hasPendingDocumentChanges()).toBe(true)
    expect((await saveDocumentAs('paper', 'external-r')).status).toBe('saved')
    expect(save.mock.lastCall?.[2]).toBe('external-r')
  })

  it('settles input drafts and transaction finalizers before taking the save snapshot', async () => {
    bind()
    const input = document.createElement('input')
    document.body.append(input)
    input.addEventListener('blur', () => edit(146))
    input.focus()
    expect((await saveCurrentDocument()).status).toBe('saved')
    expect(written().canvases[0].page.w).toBe(146)
    const unregister = registerTxnFinalizer((doc) => { doc.page.w += 1 })
    try {
      s().beginTxn(literal('drag'))
      s().txnUpdate((doc) => { doc.page.w = 150 })
      expect((await saveCurrentDocument()).status).toBe('saved')
      expect(s().txn).toBeNull()
      expect(written().canvases[0].page.w).toBe(151)
      s().undo()
      expect(s().doc.page.w).toBe(146)
    } finally { unregister() }
  })

  it('tracks all canvases while view switching and source metadata alone remain clean', () => {
    const project = emptyProject()
    project.canvases[0].objects.push({ ...panel })
    project.canvases.push({ ...project.canvases[0], id: 'second', name: 'second', objects: [] })
    install(project)
    bind()
    const first = s().activeCanvasId
    const changed = structuredClone(s().doc)
    Object.assign(changed.objects[0], { script: 'new.py', cost: 'heavy', fileKind: 'raster', pxW: 100 })
    applyDerivedUpdate({ doc: changed })
    expect(hasPendingDocumentChanges()).toBe(false)
    s().switchCanvas('second')
    expect(hasPendingDocumentChanges()).toBe(false)
    edit(155)
    expect(hasPendingCanvasChanges(first)).toBe(false)
    expect(hasPendingCanvasChanges('second')).toBe(true)
    s().undo()
    expect(hasPendingDocumentChanges()).toBe(false)
  })

  it('reopening a recovery draft restores its named target but compares with the real file', async () => {
    edit(130)
    await saveDocumentAs('paper')
    const formal = save.mock.lastCall?.[1] as ProjectDocument
    edit(140)
    const draft = s().buildProject()
    const docId = s().documentId
    install(draft, docId)
    load.mockResolvedValueOnce({ doc: formal, revision: 'disk-r' })
    restoreNamedSaveContext()
    await tick()
    expect(s().namedTarget).toEqual({ name: 'paper', projectId: currentProjectId(), revision: 'disk-r' })
    expect(hasPendingDocumentChanges()).toBe(true)
    expect((await saveCurrentDocument()).status).toBe('saved')
    expect(save.mock.lastCall?.[2]).toBe('disk-r')
  })

  it('flushes the old draft to its owning project even after the active project changes', async () => {
    const project = emptyProject()
    project.canvases[0].objects.push({ ...panel })
    await s().switchDocument(project, 'owned-by-a')
    await saveNow()
    vi.mocked(fetch).mockClear()
    setCurrentProjectId('project-b')
    edit(160)
    flushAutosave()
    await tick()
    const puts = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PUT')
    expect(puts.length).toBeGreaterThan(0)
    expect(String(puts.at(-1)?.[0])).toContain('pj=project-a')
    expect(String(puts.at(-1)?.[0])).not.toContain('project-b')
  })

  it('beforeunload settles the focused input before deciding whether to warn', () => {
    bind()
    const stop = startAutosave()
    const input = document.createElement('input')
    document.body.append(input)
    input.addEventListener('blur', () => edit(s().doc.page.w + 7))
    input.focus()
    try {
      expect(hasPendingDocumentChanges()).toBe(false)
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      expect(document.activeElement).not.toBe(input)
      expect(hasPendingDocumentChanges()).toBe(true)
      expect(event.defaultPrevented).toBe(true)
    } finally { stop() }
  })
})
