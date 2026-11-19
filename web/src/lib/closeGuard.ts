/** One leave gate for native windows, document switches, projects and canvas tabs. */
import { create } from 'zustand'
import { useDocumentStore } from '@/store/documentStore'
import { currentProjectId } from './session'
import { resolveDesktopCloseRequest } from './desktop'
import {
  hasPendingCanvasChanges, hasPendingDocumentChanges, saveCurrentDocument,
  saveDocumentAs, settleDocumentInput,
} from './namedSave'

export type CloseAnswer = 'save' | 'discard' | 'cancel'
export type CloseOutcome = 'closing' | 'stay'
export interface LeaveOptions {
  kind: 'window' | 'document' | 'project' | 'canvas'
  name?: string
  canvasId?: string
}
interface LeaveRequest extends LeaveOptions {
  documentId: string
  loadSeq: number
  projectId: string | null
  needsName: boolean
  defaultName: string
}
interface LeaveState {
  request: LeaveRequest | null
  busy: boolean
  failed: boolean
}
export const useLeaveGuard = create<LeaveState>(() => ({ request: null, busy: false, failed: false }))
let resolveLeave: ((proceed: boolean) => void) | null = null
let nativeBeginning = false

function sameDocument(request: LeaveRequest) {
  const state = useDocumentStore.getState()
  return state.documentId === request.documentId && state.loadSeq === request.loadSeq &&
    currentProjectId() === request.projectId
}

function finish(proceed: boolean) {
  const resolve = resolveLeave
  resolveLeave = null
  useLeaveGuard.setState({ request: null, busy: false, failed: false })
  resolve?.(proceed)
}

/** Cancel on actual UI teardown too: no abandoned navigation promise may remain queued. */
export function cancelLeaveRequest() { finish(false) }

export function requestLeaveDocument(options: LeaveOptions): Promise<boolean> {
  // A second close/navigation cannot replace the operation the user is answering.
  if (useLeaveGuard.getState().request) return Promise.resolve(false)
  settleDocumentInput()
  const pending = options.kind === 'canvas' && options.canvasId
    ? hasPendingCanvasChanges(options.canvasId) : hasPendingDocumentChanges()
  if (!pending) return Promise.resolve(true)
  const state = useDocumentStore.getState()
  return new Promise((resolve) => {
    resolveLeave = resolve
    useLeaveGuard.setState({
      request: {
        ...options, documentId: state.documentId, loadSeq: state.loadSeq,
        projectId: currentProjectId(), needsName: !state.namedTarget,
        defaultName: state.projectMeta.name,
      }, busy: false, failed: false,
    })
  })
}

/** A save failure keeps the same question open, so the user can retry or cancel. */
export async function answerLeaveRequest(answer: CloseAnswer, name?: string): Promise<CloseOutcome> {
  const { request, busy } = useLeaveGuard.getState()
  if (!request || busy) return 'stay'
  if (!sameDocument(request) || answer === 'cancel') {
    finish(false)
    return 'stay'
  }
  if (answer === 'discard') {
    finish(true)
    return 'closing'
  }
  useLeaveGuard.setState({ busy: true, failed: false })
  try {
    const result = request.needsName
      ? await saveDocumentAs(name?.trim() || '') : await saveCurrentDocument()
    if (useLeaveGuard.getState().request !== request) return 'stay'
    if (!sameDocument(request)) {
      finish(false)
      return 'stay'
    }
    // Compare the whole document after await: saving an older edit cannot approve
    // leaving a newer edit, including a change on another canvas.
    if (result.status !== 'saved' || hasPendingDocumentChanges()) {
      useLeaveGuard.setState({ busy: false, failed: true })
      return 'stay'
    }
    finish(true)
    return 'closing'
  } catch {
    if (useLeaveGuard.getState().request === request) {
      useLeaveGuard.setState({ busy: false, failed: true })
    }
    return 'stay'
  }
}

/** Native adapter: acknowledge the shell watchdog before awaiting human input. */
export async function beginCloseRequest(): Promise<boolean> {
  if (nativeBeginning) {
    await resolveDesktopCloseRequest('hold')
    return true
  }
  const existing = useLeaveGuard.getState().request
  if (existing) {
    await resolveDesktopCloseRequest(existing.kind === 'window' ? 'hold' : 'cancel')
    return existing.kind === 'window'
  }
  settleDocumentInput()
  if (!hasPendingDocumentChanges()) {
    await resolveDesktopCloseRequest('close')
    return false
  }
  nativeBeginning = true
  try {
    await resolveDesktopCloseRequest('hold')
    void requestLeaveDocument({ kind: 'window' }).then((proceed) =>
      resolveDesktopCloseRequest(proceed ? 'close' : 'cancel'))
    return true
  } finally { nativeBeginning = false }
}

/** Both desktop and in-app controls answer the same gate. */
export const answerCloseRequest = answerLeaveRequest
