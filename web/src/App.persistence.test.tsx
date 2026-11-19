import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { literal } from '@/i18n'
import { canvasToDoc, emptyProject } from '@/types/document'
import { projectContentKey } from '@/lib/documentCheckpoint'
import { useDocumentStore } from '@/store/documentStore'
import { useProjectStore } from '@/store/projectStore'
import { useAiStore } from '@/store/aiStore'
import { useAssetStore } from '@/store/assetStore'
import { useEnvStore } from '@/store/envStore'
import { useNativeSessionStore } from '@/store/nativeSessionStore'
import { useProjectReadinessStore } from '@/store/projectReadinessStore'
import { useTelemetryStore } from '@/store/telemetryStore'
import { setCurrentProjectId } from '@/lib/session'
import { App } from './App'

// Exercise App's real mount/unmount lifecycle and the real autosave/unload
// subscription. Individual panels and unrelated background jobs are out of scope.
vi.mock('@/canvas/CanvasStage', () => ({ CanvasStage: () => null }))
vi.mock('@/components/CanvasTabs', () => ({ CanvasTabs: () => null }))
vi.mock('@/components/CloseGuardDialog', () => ({ CloseGuardDialog: () => null }))
vi.mock('@/components/ConfirmDialog', () => ({ ConfirmDialog: () => null }))
vi.mock('@/components/ExportDialog', () => ({ ExportDialog: () => null }))
vi.mock('@/components/inspector/Inspector', () => ({ Inspector: () => null }))
vi.mock('@/components/LayoutDialog', () => ({ LayoutDialog: () => null }))
vi.mock('@/components/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('@/components/FigurePickerDialog', () => ({ FigurePickerDialog: () => null }))
vi.mock('@/components/NativeConfirmDialog', () => ({ NativeConfirmDialog: () => null }))
vi.mock('@/components/NativeSessionCards', () => ({ NativeSessionCards: () => null }))
vi.mock('@/components/RegistryDialog', () => ({ RegistryDialog: () => null }))
vi.mock('@/components/RelinkDialog', () => ({ RelinkDialog: () => null }))
vi.mock('@/components/SettingsDialog', () => ({ SettingsDialog: () => null }))
vi.mock('@/components/TelemetryConsentDialog', () => ({ TelemetryConsentDialog: () => null }))
vi.mock('@/components/ShortcutHelp', () => ({ ShortcutHelp: () => null }))
vi.mock('@/components/StyleDialog', () => ({ StyleDialog: () => null }))
vi.mock('@/components/DocumentBanner', () => ({ DocumentBanner: () => null }))
vi.mock('@/components/ProjectReadinessBanner', () => ({ ProjectReadinessBanner: () => null }))
vi.mock('@/components/VersionDialog', () => ({ VersionDrawer: () => null }))
vi.mock('@/components/left/LeftPanel', () => ({ LeftPanel: () => null }))
vi.mock('@/components/left/LeftRail', () => ({ LeftRail: () => null }))
vi.mock('@/components/PerfProbeHud', () => ({ PerfProbeHud: () => null }))
vi.mock('@/components/TopBar', () => ({ TopBar: () => null }))
vi.mock('@/components/UpdateBanner', () => ({ UpdateBanner: () => null }))
vi.mock('@/components/UpdateNoticeDialog', () => ({ UpdateNoticeDialog: () => null }))
vi.mock('@/components/DependencyPrepareDialog', () => ({ DependencyPrepareDialog: () => null }))
vi.mock('@/components/WorkdirConfirmDialog', () => ({ WorkdirConfirmDialog: () => null }))
vi.mock('@/components/ProjectPicker', () => ({ ProjectPicker: () => null }))
vi.mock('@/components/onboarding/OnboardingLayer', () => ({ OnboardingLayer: () => null }))
vi.mock('@/components/StatusBar', () => ({ CanvasHud: () => null, NotificationRail: () => null }))
vi.mock('@/hooks/useEngineSync', () => ({ EngineRenderSync: () => null, useEngineDocumentSync: () => {} }))
vi.mock('@/hooks/useKeyboard', () => ({ useKeyboard: () => {}, runUndoRedo: () => {} }))
vi.mock('@/hooks/useServerEvents', () => ({ useServerEvents: () => {} }))
vi.mock('@/hooks/useBuildVersion', () => ({ useBuildVersion: () => false }))
vi.mock('@/hooks/useWorkspaceLayout', () => ({ useWorkspaceLayout: () => 'wide' }))
vi.mock('@/hooks/usePruneSelection', () => ({ subscribePruneSelection: () => () => {} }))
vi.mock('@/hooks/useVersionCheckpoints', () => ({ startVersionCheckpoints: () => () => {} }))
vi.mock('@/store/styleBinding', () => ({ startStyleBindingSync: () => () => {} }))
vi.mock('@/store/liveSync', () => ({ startDocumentLoadSync: () => () => {}, syncLoadedDocument: () => {} }))
vi.mock('@/lib/onboarding/flow', () => ({ startOnboardingEngine: () => () => {} }))
vi.mock('@/lib/onboarding/hints', () => ({ startHintEngine: () => () => {} }))
vi.mock('@/lib/activityTelemetry', () => ({ startActivityTelemetry: () => () => {} }))
vi.mock('@/diagnostics/wiring', () => ({ installDiagnosticsWiring: () => () => {} }))
vi.mock('@/store/updateStore', async (original) => ({
  ...await original<typeof import('@/store/updateStore')>(), checkUpdateOnStartup: () => {},
}))
vi.mock('@/store/documentStore', async (original) => ({
  ...await original<typeof import('@/store/documentStore')>(), restoreSession: async () => false,
}))
vi.mock('@/store/actions', async (original) => ({
  ...await original<typeof import('@/store/actions')>(), startLayoutAutoReflow: () => () => {},
}))
vi.mock('@/store/validationStore', async (original) => ({
  ...await original<typeof import('@/store/validationStore')>(), startValidation: () => () => {},
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root | null = null
let host: HTMLDivElement | null = null

beforeEach(() => {
  localStorage.clear()
  setCurrentProjectId('app-project')
  const project = emptyProject()
  useDocumentStore.setState({
    doc: canvasToDoc(project.canvases[0]), canvases: project.canvases,
    documentId: 'app-document', projectMeta: { ...project.project, createdAt: project.createdAt },
    activeCanvasId: project.canvases[0].id, openTabs: [project.canvases[0].id], canvasSessions: {},
    loadSeq: useDocumentStore.getState().loadSeq + 1, past: [], future: [], txn: null,
    namedTarget: null, savedCheckpoint: projectContentKey(project), namedSaveState: 'idle',
    namedSaveIssue: null, dirty: false, saveState: 'clean', saveIssue: null,
  })
  useProjectStore.setState({
    phase: 'open', project: { open: true, id: 'app-project', name: 'App', figures_dir: '/app' },
    switching: false,
  })
  vi.spyOn(useProjectStore.getState(), 'init').mockResolvedValue()
  vi.spyOn(useEnvStore.getState(), 'refresh').mockResolvedValue()
  vi.spyOn(useTelemetryStore.getState(), 'load').mockResolvedValue()
  vi.spyOn(useAssetStore.getState(), 'load').mockResolvedValue(null)
  vi.spyOn(useAiStore.getState(), 'loadCaps').mockResolvedValue()
  vi.spyOn(useProjectReadinessStore.getState(), 'load').mockResolvedValue(null)
  vi.spyOn(useNativeSessionStore.getState(), 'refresh').mockResolvedValue()
  vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => init?.method === 'PUT'
    ? new Response('{"ok":true,"saved_at":1,"revision":"r1"}', { status: 200 })
    : new Response('{}', { status: 404 })))
})

afterEach(async () => {
  if (root) await act(async () => { root!.unmount() })
  root = null
  host?.remove()
  host = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setCurrentProjectId(null)
})

async function mount() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(<App />) })
}

async function unloading() {
  const event = new Event('beforeunload', { cancelable: true })
  await act(async () => { window.dispatchEvent(event) })
  return event.defaultPrevented
}

describe('App-owned recovery autosave and browser close guard', () => {
  it('one subscription spans Workspace → Picker → Workspace, and unregisters only with App', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const registrations = () => add.mock.calls.filter(([name]) => String(name) === 'beforeunload')
    const removals = () => remove.mock.calls.filter(([name]) => String(name) === 'beforeunload')
    await mount()
    expect(registrations()).toHaveLength(1)
    expect(await unloading()).toBe(false)
    act(() => useDocumentStore.getState().commit(literal('edit'), (doc) => { doc.page.w += 1 }))
    expect(await unloading()).toBe(true)
    await act(async () => { useProjectStore.getState().showPicker() })
    expect(useProjectStore.getState().phase).toBe('none')
    expect(await unloading()).toBe(true)
    expect(registrations()).toHaveLength(1)
    expect(removals()).toHaveLength(0)
    await act(async () => { useProjectStore.getState().returnToCurrent() })
    expect(await unloading()).toBe(true)
    expect(registrations()).toHaveLength(1)
    expect(removals()).toHaveLength(0)
    await act(async () => { root!.unmount() })
    root = null
    expect(removals()).toHaveLength(1)
    expect(await unloading()).toBe(false)
  })

  it('subscribing during startup does not classify loaded content as a new edit', async () => {
    useProjectStore.setState({ phase: 'loading', project: null })
    await mount()
    const project = emptyProject()
    project.canvases[0].objects.push({
      id: 'loaded-text', type: 'text', text: 'loaded', sizePt: 9, bold: false,
      color: '#000000', align: 'left', x: 1, y: 1, w: 20, h: 8,
    })
    act(() => useDocumentStore.setState({
      doc: canvasToDoc(project.canvases[0]), canvases: project.canvases,
      activeCanvasId: project.canvases[0].id, loadSeq: useDocumentStore.getState().loadSeq + 1,
      savedCheckpoint: projectContentKey(project), dirty: false, saveState: 'clean',
    }))
    expect(useDocumentStore.getState().dirty).toBe(false)
    expect(useDocumentStore.getState().saveState).toBe('clean')
    expect(await unloading()).toBe(false)
  })
})
