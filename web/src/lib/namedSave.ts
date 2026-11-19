import { ApiError, REVISION_ABSENT, fetchLayout, saveLayout } from '@/lib/api'
import { currentProjectId } from '@/lib/session'
import { knownLayoutRevision, rememberLayoutRevision } from '@/lib/layoutRevision'
import { normalizeLayout } from '@/lib/migrate'
import { migrateToProject } from '@/types/document'
import { canvasContentKey, currentContentKey, projectContentKey, savedCanvasContentKey } from '@/lib/documentCheckpoint'
import { documentHasContent } from '@/lib/projectDocs'
import { useDocumentStore, type DocumentState } from '@/store/documentStore'
import { finishActiveGesture } from '@/store/gestureCoordinator'

export interface NamedDocumentTarget { name: string; projectId: string | null; revision: string | null }
export type NamedSaveState = 'idle' | 'saving' | 'error' | 'conflict'
export type DocumentSaveStatus = 'clean' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict'
export type DocumentSaveResult = { status: 'saved' | 'needs_name' | 'error' | 'stale'; error?: unknown }
const targetKey = (id: string) => `tavotto.namedDocument.${id}`
const contextKey = (state: DocumentState) => `${currentProjectId() ?? ''}::${state.documentId}::${state.loadSeq}`
const restoring = new Map<string, Promise<void>>()

/** Settle local input drafts and the same gesture transaction used by undo. */
export function settleDocumentInput(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement && (active.matches('input, textarea') || active.isContentEditable)) active.blur()
  finishActiveGesture()
  const state = useDocumentStore.getState()
  if (state.txn) state.endTxn()
}

export function getDocumentSaveStatus(state: DocumentState): DocumentSaveStatus {
  if (state.namedSaveState !== 'idle') return state.namedSaveState
  if (state.txn?.patches.length) return 'dirty'
  if (state.savedCheckpoint === null) return documentHasContent(state) ? 'dirty' : 'clean'
  return currentContentKey(state) === state.savedCheckpoint ? 'clean' : 'dirty'
}

export function hasPendingDocumentChanges(): boolean {
  const status = getDocumentSaveStatus(useDocumentStore.getState())
  return status !== 'clean' && status !== 'saved'
}

export function hasPendingCanvasChanges(canvasId: string): boolean {
  const state = useDocumentStore.getState()
  if (canvasId === state.activeCanvasId && state.txn?.patches.length) return true
  const current = canvasContentKey(state, canvasId)
  if (current === null) return false
  if (state.savedCheckpoint === null && !documentHasContent(state)) return false
  return current !== savedCanvasContentKey(state.savedCheckpoint, canvasId)
}

function rememberTarget(id: string, target: NamedDocumentTarget): void {
  // Remember identity only. Checkpoint/revision are re-read from the named file
  // next session; the recovery draft is never promoted into a saved checkpoint.
  try { localStorage.setItem(targetKey(id), JSON.stringify({ name: target.name, projectId: target.projectId })) } catch { /* session-only fallback */ }
}

export function bindNamedDocumentTarget(target: { name: string; revision: string | null; projectId?: string | null }): void {
  const state = useDocumentStore.getState()
  const namedTarget = { ...target, projectId: target.projectId === undefined ? currentProjectId() : target.projectId }
  rememberLayoutRevision(namedTarget.name, namedTarget.revision, namedTarget.projectId)
  rememberTarget(state.documentId, namedTarget)
  useDocumentStore.setState({ namedTarget, savedCheckpoint: currentContentKey(state), namedSaveState: 'idle', namedSaveIssue: null, namedSavedAt: null })
}

/** Called only after a document load. Draft recovery does not claim a formal save. */
export function restoreNamedSaveContext(): void {
  const state = useDocumentStore.getState()
  const baseline = documentHasContent(state) ? null : currentContentKey(state)
  useDocumentStore.setState({ namedTarget: null, savedCheckpoint: baseline, namedSaveState: 'idle', namedSaveIssue: null, namedSavedAt: null })
  let stored: { name?: unknown; projectId?: unknown } | null = null
  try { stored = JSON.parse(localStorage.getItem(targetKey(state.documentId)) ?? 'null') } catch { /* unknown target */ }
  if (!stored || typeof stored.name !== 'string' || stored.projectId !== currentProjectId()) return
  const target: NamedDocumentTarget = { name: stored.name, projectId: currentProjectId(), revision: null }
  useDocumentStore.setState({ namedTarget: target })
  const context = contextKey(state)
  const promise = Promise.resolve(fetchLayout(target.name, target.projectId)).then(({ doc, revision }) => {
    const now = useDocumentStore.getState()
    if (currentProjectId() !== target.projectId || now.documentId !== state.documentId || now.loadSeq !== state.loadSeq || now.namedTarget !== target) return
    const namedTarget = { ...target, revision }
    rememberLayoutRevision(target.name, revision, target.projectId)
    const project = migrateToProject(normalizeLayout(doc, target.name))
    if (project) useDocumentStore.setState({ namedTarget, savedCheckpoint: projectContentKey(project) })
  }).catch(() => { /* no verified checkpoint: keep draft unsaved, future writes use absent */ })
    .finally(() => restoring.delete(context))
  restoring.set(context, promise)
}

const inFlight = new Map<string, { name: string; promise: Promise<DocumentSaveResult> }>()

export async function saveCurrentDocument(): Promise<DocumentSaveResult> {
  settleDocumentInput()
  const context = contextKey(useDocumentStore.getState())
  await restoring.get(context)
  if (contextKey(useDocumentStore.getState()) !== context) return { status: 'stale' }
  const target = useDocumentStore.getState().namedTarget
  if (!target) return { status: 'needs_name' }
  if (target.projectId !== currentProjectId()) return { status: 'stale' }
  return saveDocumentAs(target.name)
}

export async function saveDocumentAs(name: string, baseRevision?: string): Promise<DocumentSaveResult> {
  settleDocumentInput()
  const stem = name.trim()
  if (!stem) return Promise.resolve({ status: 'needs_name' })
  const context = contextKey(useDocumentStore.getState())
  await restoring.get(context)
  if (contextKey(useDocumentStore.getState()) !== context) return { status: 'stale' }
  const state = useDocumentStore.getState()
  const pj = currentProjectId()
  const active = inFlight.get(context)
  if (active) return active.name === stem ? active.promise : Promise.resolve({ status: 'stale' })
  const snapshot = state.buildProject()
  const checkpoint = projectContentKey(snapshot)
  const targetBefore = state.namedTarget
  const revision = baseRevision ?? (targetBefore?.name === stem && targetBefore.projectId === pj ? targetBefore.revision : null)
    ?? knownLayoutRevision(stem, pj) ?? REVISION_ABSENT
  const stillCurrent = () => {
    const now = useDocumentStore.getState()
    return now.documentId === state.documentId && now.loadSeq === state.loadSeq && currentProjectId() === pj && now.namedTarget === targetBefore
  }
  useDocumentStore.setState({ namedSaveState: 'saving', namedSaveIssue: null })
  const promise = (async (): Promise<DocumentSaveResult> => {
    try {
      // Register the in-flight operation before even a synchronous API failure.
      await Promise.resolve()
      const result = await saveLayout(stem, snapshot, revision, pj)
      rememberLayoutRevision(stem, result.revision, pj)
      if (!stillCurrent()) return { status: 'stale' }
      const target = { name: stem, projectId: pj, revision: result.revision }
      rememberTarget(state.documentId, target)
      useDocumentStore.setState({ namedTarget: target, savedCheckpoint: checkpoint, namedSaveState: 'idle', namedSaveIssue: null, namedSavedAt: Date.now() })
      return { status: hasPendingDocumentChanges() ? 'stale' : 'saved' }
    } catch (error) {
      if (!stillCurrent()) return { status: 'stale', error }
      useDocumentStore.setState({ namedSaveState: error instanceof ApiError && error.status === 409 ? 'conflict' : 'error', namedSaveIssue: error })
      return { status: 'error', error }
    } finally {
      inFlight.delete(context)
    }
  })()
  inFlight.set(context, { name: stem, promise })
  return promise
}
