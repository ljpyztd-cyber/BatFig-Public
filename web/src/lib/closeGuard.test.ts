import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { literal } from '@/i18n'
import { canvasToDoc, emptyProject, type ProjectDocument } from '@/types/document'
import { useDocumentStore } from '@/store/documentStore'
import { ApiError, saveLayout } from './api'
import { bindNamedDocumentTarget } from './namedSave'
import { setCurrentProjectId } from './session'
import { projectContentKey } from './documentCheckpoint'
import { forgetLayoutRevisions } from './layoutRevision'
import { resolveDesktopCloseRequest } from './desktop'
import { answerLeaveRequest, beginCloseRequest, cancelLeaveRequest, requestLeaveDocument, useLeaveGuard } from './closeGuard'

vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('./api')>(), saveLayout: vi.fn() }))
vi.mock('@/lib/desktop', async (original) => ({
  ...await original<typeof import('./desktop')>(), resolveDesktopCloseRequest: vi.fn().mockResolvedValue(true),
}))
const s = () => useDocumentStore.getState()
const save = vi.mocked(saveLayout)
const said = vi.mocked(resolveDesktopCloseRequest)
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function edit(width: number) { s().commit(literal('width'), (doc) => { doc.page.w = width }) }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  cancelLeaveRequest()
  localStorage.clear()
  forgetLayoutRevisions()
  setCurrentProjectId('close-project')
  const pd = emptyProject()
  useDocumentStore.setState({
    doc: canvasToDoc(pd.canvases[0]), canvases: pd.canvases,
    documentId: 'close-document', projectMeta: { ...pd.project, createdAt: pd.createdAt },
    activeCanvasId: pd.canvases[0].id, openTabs: [pd.canvases[0].id], canvasSessions: {},
    loadSeq: s().loadSeq + 1, past: [], future: [], txn: null,
    namedTarget: null, savedCheckpoint: projectContentKey(pd), namedSaveState: 'idle', namedSaveIssue: null,
    dirty: false, saveState: 'clean', saveIssue: null,
  })
  save.mockReset().mockResolvedValue({ ok: true, revision: 'r2' })
  said.mockClear()
})
afterEach(() => { cancelLeaveRequest(); document.body.innerHTML = '' })

describe('leave checks the named file, not the recovery draft', () => {
  it('clean closes without a dialog; undo to checkpoint restores that behavior', async () => {
    bindNamedDocumentTarget({ name: 'paper', revision: 'r1' })
    edit(123)
    s().undo()
    expect(await requestLeaveDocument({ kind: 'document' })).toBe(true)
    expect(await beginCloseRequest()).toBe(false)
    expect(said).toHaveBeenCalledWith('close')
    expect(useLeaveGuard.getState().request).toBeNull()
  })
  it('autosave saved still holds a changed named file and cancel stays', async () => {
    edit(123)
    useDocumentStore.setState({ saveState: 'saved' })
    expect(await beginCloseRequest()).toBe(true)
    expect(said).toHaveBeenCalledWith('hold')
    await answerLeaveRequest('cancel')
    await tick()
    expect(said).toHaveBeenLastCalledWith('cancel')
    expect(save).not.toHaveBeenCalled()
  })
  it('first save requires a name; cancel does not create a file', async () => {
    edit(123)
    const leaving = requestLeaveDocument({ kind: 'document' })
    expect(useLeaveGuard.getState().request?.needsName).toBe(true)
    expect(await answerLeaveRequest('save', ' ')).toBe('stay')
    expect(useLeaveGuard.getState().failed).toBe(true)
    await answerLeaveRequest('cancel')
    expect(await leaving).toBe(false)
    expect(save).not.toHaveBeenCalled()
  })
  it('saves named content to disk before releasing the native close', async () => {
    edit(123)
    await beginCloseRequest()
    expect(await answerLeaveRequest('save', 'paper')).toBe('closing')
    await tick()
    expect(save.mock.lastCall?.slice(2)).toEqual(['absent', 'close-project'])
    expect((save.mock.calls[0][1] as ProjectDocument).canvases[0].page.w).toBe(123)
    expect(said).toHaveBeenLastCalledWith('close')
  })
  it.each([500, 409])('save HTTP %i stays open for retry/cancel, never overwrites', async (status) => {
    bindNamedDocumentTarget({ name: 'paper', revision: 'r1' })
    edit(123)
    save.mockRejectedValueOnce(new ApiError('failed', status, {}))
    const leaving = requestLeaveDocument({ kind: 'project' })
    expect(await answerLeaveRequest('save')).toBe('stay')
    expect(useLeaveGuard.getState().busy).toBe(false)
    expect(useLeaveGuard.getState().failed).toBe(true)
    expect(save.mock.lastCall?.[2]).toBe('r1')
    await answerLeaveRequest('cancel')
    expect(await leaving).toBe(false)
  })
  it('save receipt for an older edit cannot release a newer edit', async () => {
    bindNamedDocumentTarget({ name: 'paper', revision: 'r1' })
    edit(123)
    const disk = deferred<{ ok: boolean; revision: string }>()
    save.mockReturnValueOnce(disk.promise)
    const leaving = requestLeaveDocument({ kind: 'window' })
    const saving = answerLeaveRequest('save')
    await tick()
    edit(124)
    disk.resolve({ ok: true, revision: 'r2' })
    expect(await saving).toBe('stay')
    expect(useLeaveGuard.getState().failed).toBe(true)
    await answerLeaveRequest('cancel')
    expect(await leaving).toBe(false)
  })
  it('late receipt from a previous document never authorizes leaving the current one', async () => {
    bindNamedDocumentTarget({ name: 'paper', revision: 'r1' })
    edit(123)
    const disk = deferred<{ ok: boolean; revision: string }>()
    save.mockReturnValueOnce(disk.promise)
    const leaving = requestLeaveDocument({ kind: 'document' })
    const saving = answerLeaveRequest('save')
    await tick()
    useDocumentStore.setState({ documentId: 'other', loadSeq: s().loadSeq + 1 })
    disk.resolve({ ok: true, revision: 'r2' })
    expect(await saving).toBe('stay')
    expect(await leaving).toBe(false)
  })
  it('duplicate close does not replace the question; teardown resolves its promise', async () => {
    edit(123)
    const first = requestLeaveDocument({ kind: 'canvas', canvasId: s().activeCanvasId })
    const request = useLeaveGuard.getState().request
    expect(await requestLeaveDocument({ kind: 'project' })).toBe(false)
    expect(useLeaveGuard.getState().request).toBe(request)
    cancelLeaveRequest()
    expect(await first).toBe(false)
  })
  it('discard continues without a formal save and preserves the canvas data', async () => {
    edit(123)
    const leaving = requestLeaveDocument({ kind: 'canvas', canvasId: s().activeCanvasId })
    expect(await answerLeaveRequest('discard')).toBe('closing')
    expect(await leaving).toBe(true)
    expect(save).not.toHaveBeenCalled()
    expect(s().doc.page.w).toBe(123)
  })
  it('pending input is blurred and committed before the close predicate is evaluated', async () => {
    const input = document.createElement('input')
    input.addEventListener('blur', () => edit(123))
    document.body.appendChild(input)
    input.focus()
    const leaving = requestLeaveDocument({ kind: 'document' })
    expect(useLeaveGuard.getState().request).not.toBeNull()
    expect(s().doc.page.w).toBe(123)
    await answerLeaveRequest('cancel')
    expect(await leaving).toBe(false)
  })
})
