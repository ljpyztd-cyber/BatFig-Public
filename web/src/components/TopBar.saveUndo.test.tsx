import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const officialStatus = vi.hoisted(() => ({ value: 'clean' as 'clean' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict' }))

vi.mock('@/lib/namedSave', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/namedSave')>()),
  // This suite verifies the toolbar consumes the official status. Checkpoint
  // comparison and disk I/O have their own tests in namedSave.
  getDocumentSaveStatus: () => officialStatus.value,
}))
vi.mock('@/store/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/store/actions')>()),
  runManualSave: vi.fn().mockResolvedValue(undefined),
  openLayoutDocument: vi.fn().mockResolvedValue(false),
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  openPackage: vi.fn(),
}))
vi.mock('@/lib/clipboard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/clipboard')>()),
  requestRelinkMissing: vi.fn().mockReturnValue(0),
}))

import { TopBar } from './TopBar'
import { TooltipProvider } from './ui/Tooltip'
import { i18n, literal } from '@/i18n'
import { openLayoutDocument, runManualSave } from '@/store/actions'
import { openPackage } from '@/lib/api'
import { requestRelinkMissing } from '@/lib/clipboard'
import { useDocumentStore } from '@/store/documentStore'
import { useInteractionStore } from '@/store/interactionStore'
import { useWorkspaceStore } from '@/store/workspace'
import { useUiStore } from '@/store/uiStore'
import { emptyProject } from '@/types/document'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never

let root: Root | null = null
let host: HTMLDivElement | null = null
const initialDocument = useDocumentStore.getState()

function mount() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<TooltipProvider><TopBar /></TooltipProvider>))
}

function action(name: 'undo' | 'redo' | 'save') {
  const button = host?.querySelector<HTMLButtonElement>(`[data-document-action="${name}"]`)
  expect(button).toBeInstanceOf(HTMLButtonElement)
  return button!
}

function setStatus(value: typeof officialStatus.value) {
  act(() => {
    officialStatus.value = value
    useDocumentStore.setState({ namedSaveState: value === 'saving' || value === 'error' || value === 'conflict' ? value : 'idle' })
  })
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))
  vi.mocked(runManualSave).mockReset().mockResolvedValue(undefined)
  vi.mocked(openLayoutDocument).mockReset().mockResolvedValue(false)
  vi.mocked(openPackage).mockReset()
  vi.mocked(requestRelinkMissing).mockClear()
  officialStatus.value = 'clean'
  useDocumentStore.setState(initialDocument, true)
  useInteractionStore.setState({ kind: 'none' })
  useWorkspaceStore.setState({ mode: 'layout' })
  useUiStore.getState().setStatus(null)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  vi.unstubAllGlobals()
  useUiStore.getState().setStatus(null)
})

describe('visible document controls', () => {
  it('keeps three named native buttons outside menus, with keyboard focus and shortcut metadata', () => {
    mount()
    expect(action('undo').textContent).toBe('撤销')
    expect(action('redo').textContent).toBe('重做')
    expect(action('save').textContent).toBe('保存')
    expect(action('save').getAttribute('aria-keyshortcuts')).toMatch(/(?:Control|Meta)\+S/)
    expect(action('undo').getAttribute('aria-keyshortcuts')).toMatch(/(?:Control|Meta)\+Z/)
    expect(action('redo').getAttribute('aria-keyshortcuts')).toContain('Shift+Z')
    expect(host!.querySelectorAll('[data-document-actions] button')).toHaveLength(3)
    for (const button of [action('undo'), action('redo'), action('save')]) {
      expect(button.type).toBe('button')
      expect(button.tabIndex).toBe(0)
    }
    act(() => action('save').focus())
    expect(document.activeElement).toBe(action('save'))
  })

  it('updates Undo and Redo from real history and applies each through the shared action', () => {
    mount()
    expect(action('undo').disabled).toBe(true)
    expect(action('redo').disabled).toBe(true)
    const before = useDocumentStore.getState().doc.name
    act(() => useDocumentStore.getState().commit(literal('rename'), (doc) => { doc.name = 'edited' }))
    expect(action('undo').disabled).toBe(false)
    act(() => action('undo').click())
    expect(useDocumentStore.getState().doc.name).toBe(before)
    expect(action('undo').disabled).toBe(true)
    expect(action('redo').disabled).toBe(false)
    act(() => action('redo').click())
    expect(useDocumentStore.getState().doc.name).toBe('edited')
    expect(action('redo').disabled).toBe(true)
  })

  it('disables history actions during a canvas gesture and keeps the pending history intact', () => {
    mount()
    act(() => useDocumentStore.getState().commit(literal('rename'), (doc) => { doc.name = 'edited' }))
    act(() => useInteractionStore.setState({ kind: 'move' }))
    expect(action('undo').disabled).toBe(true)
    act(() => action('undo').click())
    expect(useDocumentStore.getState().doc.name).toBe('edited')
    act(() => useInteractionStore.setState({ kind: 'none' }))
    expect(action('undo').disabled).toBe(false)
  })

  it('uses the shared save entry once while pending and exposes a retry after failure', async () => {
    let finish!: () => void
    vi.mocked(runManualSave).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    mount()
    setStatus('dirty')
    act(() => action('save').click())
    expect(runManualSave).toHaveBeenCalledTimes(1)
    expect(action('save').disabled).toBe(true)
    expect(action('save').getAttribute('aria-busy')).toBe('true')
    act(() => action('save').click())
    expect(runManualSave).toHaveBeenCalledTimes(1)
    setStatus('saving')
    expect(host!.querySelector('[data-document-save-state]')!.textContent).toBe('正在保存…')
    setStatus('error')
    await act(async () => { finish(); await Promise.resolve() })
    expect(action('save').disabled).toBe(false)
    expect(host!.querySelector('[data-document-save-state]')!.textContent).toBe('保存失败')
    vi.mocked(runManualSave).mockResolvedValue(undefined)
    await act(async () => action('save').click())
    expect(runManualSave).toHaveBeenCalledTimes(2)
  })

  it('never describes a recovered draft as a formally saved document', () => {
    mount()
    act(() => useDocumentStore.setState({ saveState: 'saved', lastPersisted: Date.now(), namedTarget: null }))
    expect(host!.querySelector('[data-document-save-state]')!.textContent).toBe('尚未保存')
    setStatus('dirty')
    expect(host!.querySelector('[data-document-save-state]')!.textContent).toBe('有未保存修改')
    setStatus('conflict')
    expect(host!.querySelector('[data-document-save-state]')!.textContent).toBe('外部冲突')
  })

  it('retains the document controls in single-figure mode and switches visible labels to English', async () => {
    useWorkspaceStore.setState({ mode: 'fast_edit' })
    mount()
    expect(host!.querySelector('[data-topbar-marks]')).toBeNull()
    await act(async () => { await i18n.changeLanguage('en-US') })
    expect(action('undo').textContent).toBe('Undo')
    expect(action('redo').textContent).toBe('Redo')
    expect(action('save').textContent).toBe('Save')
  })

  it('stops package import when the user cancels leaving the current document', async () => {
    vi.mocked(openPackage).mockResolvedValue({ doc: emptyProject(), manifest: {}, missing: [], drifted: [] })
    const file = new File(['package'], 'trial.tavotto')
    const chooser = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, 'files', { value: [file] })
      this.dispatchEvent(new Event('change'))
    })
    try {
      mount()
      await act(async () => {
        host!.querySelector('[data-document-menu]')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      })
      const item = document.querySelector<HTMLElement>('[data-document-action="import-package"]')
      expect(item).not.toBeNull()
      await act(async () => {
        item!.click()
        for (let i = 0; i < 12; i++) await Promise.resolve()
      })
      expect(openPackage).toHaveBeenCalledWith(file)
      expect(openLayoutDocument).toHaveBeenCalledTimes(1)
      expect(requestRelinkMissing).not.toHaveBeenCalled()
      expect(useUiStore.getState().status).toBeNull()
      expect(useDocumentStore.getState().documentId).toBe(initialDocument.documentId)
    } finally { chooser.mockRestore() }
  })
})
