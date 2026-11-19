import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CloseGuardDialog } from './CloseGuardDialog'
import { i18n, literal } from '@/i18n'
import { useDocumentStore } from '@/store/documentStore'
import { canvasToDoc, emptyProject } from '@/types/document'
import { projectContentKey } from '@/lib/documentCheckpoint'
import { requestLeaveDocument, useLeaveGuard } from '@/lib/closeGuard'
import { saveLayout } from '@/lib/api'
import { setCurrentProjectId } from '@/lib/session'
vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), saveLayout: vi.fn() }))

let root: Root
let host: HTMLDivElement
const s = () => useDocumentStore.getState()
const query = (action: string) => document.querySelector<HTMLButtonElement>(`[data-leave-action="${action}"]`)!
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  await i18n.changeLanguage('zh-CN')
  setCurrentProjectId('close-ui')
  const pd = emptyProject()
  useDocumentStore.setState({
    doc: canvasToDoc(pd.canvases[0]), canvases: pd.canvases, activeCanvasId: pd.canvases[0].id,
    projectMeta: { ...pd.project, createdAt: pd.createdAt }, documentId: 'close-ui', loadSeq: s().loadSeq + 1,
    past: [], future: [], txn: null, savedCheckpoint: projectContentKey(pd), namedTarget: null,
    namedSaveState: 'idle', namedSaveIssue: null,
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<CloseGuardDialog />))
})
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; vi.clearAllMocks() })

it('unnamed close offers three actions and a filename; cancel keeps the content', async () => {
  s().commit(literal('edit'), (doc) => { doc.page.w = 123 })
  let pending!: Promise<boolean>
  act(() => { pending = requestLeaveDocument({ kind: 'document' }) })
  expect(document.querySelector('[data-dialog="unsaved-changes"]')).not.toBeNull()
  expect(document.querySelector('[data-leave-filename]')).not.toBeNull()
  expect(query('save').textContent).toContain('保存并继续')
  expect(query('discard')).not.toBeNull()
  await act(async () => { query('cancel').click(); await tick() })
  expect(await pending).toBe(false)
  expect(s().doc.page.w).toBe(123)
})

it('failed save shows an error, releases busy and leaves all choices available', async () => {
  vi.mocked(saveLayout).mockRejectedValueOnce(new Error('disk full'))
  s().commit(literal('edit'), (doc) => { doc.page.w = 123 })
  let pending!: Promise<boolean>
  act(() => { pending = requestLeaveDocument({ kind: 'canvas', canvasId: s().activeCanvasId }) })
  await act(async () => { query('save').click(); await tick() })
  expect(document.querySelector('[data-leave-error]')).not.toBeNull()
  expect(query('cancel').disabled).toBe(false)
  expect(query('discard').textContent).toContain('仅关闭标签')
  expect(useLeaveGuard.getState().request).not.toBeNull()
  await act(async () => { query('cancel').click(); await tick() })
  expect(await pending).toBe(false)
})
