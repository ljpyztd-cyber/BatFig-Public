import { useMemo } from 'react'
import { canvasAlignmentGeometry } from '@/lib/canvasAlignment'
import type { CanvasObject } from '@/types/document'
import { useArrangeStore, type AlignBasis } from './arrangeStore'
import { useAssetStore } from './assetStore'
import { useDocumentStore } from './documentStore'
import { exactPanelManifest, renderKeyOf, useRenderStore } from './renderStore'
import { requestRender } from './renderScheduler'
import { useSelectionStore } from './selectionStore'

function resolve(
  objects: CanvasObject[],
  basis: AlignBasis,
  byKey: ReturnType<typeof useRenderStore.getState>['byKey'],
  panels: ReturnType<typeof useAssetStore.getState>['panels'],
) {
  return canvasAlignmentGeometry(
    objects,
    basis,
    (panel) => exactPanelManifest({ byKey }, panel),
    (panel) => panels.find((asset) => asset.id === panel.fileId)?.capability?.status === 'layout_only',
  )
}

export function readCanvasAlignment(objects: CanvasObject[], basis: AlignBasis) {
  return resolve(objects, basis, useRenderStore.getState().byKey, useAssetStore.getState().panels)
}

/** Explicit user request: reopened runtime panels must never execute on selection alone. */
export function prepareCanvasAlignment() {
  const ids = useSelectionStore.getState().ids
  for (const panel of useDocumentStore.getState().doc.objects) {
    if (panel.type !== 'panel' || !ids.includes(panel.id)) continue
    const state = useRenderStore.getState()
    if (exactPanelManifest(state, panel)) continue
    if (useAssetStore.getState().byId[panel.fileId]?.capability?.status === 'layout_only') continue
    if (state.byKey[renderKeyOf(panel)]?.status === 'rendering') continue
    requestRender(panel, 'immediate')
  }
}

export function useCanvasAlignment() {
  const objects = useDocumentStore((s) => s.doc.objects)
  const ids = useSelectionStore((s) => s.ids)
  const basis = useArrangeStore((s) => s.alignBasis)
  const byKey = useRenderStore((s) => s.byKey)
  const panels = useAssetStore((s) => s.panels)
  return useMemo(
    () => resolve(objects.filter((o) => ids.includes(o.id)), basis, byKey, panels),
    [objects, ids, basis, byKey, panels],
  )
}
