import { useMemo } from 'react'
import { create } from 'zustand'
import { msg } from '@/i18n'
import { panelAxesBounds } from '@/lib/canvasAlignment'
import { fracBoxToMm, isElementHidden } from '@/lib/elementGeom'
import type { Rect } from '@/lib/geometry'
import { settleDocumentInput } from '@/lib/namedSave'
import { normalizePanelGridSettings, panelGridReadingOrder, planPanelGrid, type PanelGridSettings } from '@/lib/panelGrid'
import { planPanelGridLabels } from '@/lib/panelGridLabels'
import { planPanelGridLabelClearance } from '@/lib/panelGridLabelClearance'
import { panelRotation, type FigureDocument, type PanelObject } from '@/types/document'
import { useAssetStore } from './assetStore'
import { useDocumentStore } from './documentStore'
import { requestRender } from './renderScheduler'
import { exactPanelManifest, renderKeyOf, useRenderStore } from './renderStore'
import { useUiStore } from './uiStore'
import { preparePlotFramePanels } from './plotFramePrepare'

type RenderState = ReturnType<typeof useRenderStore.getState>
type AssetState = ReturnType<typeof useAssetStore.getState>
const useGridActivity = create<{ busy: boolean }>(() => ({ busy: false }))

/** The first application records reading order; changing a ratio never re-sorts rows. */
function gridPanels(doc: FigureDocument, order: readonly string[] = []): PanelObject[] {
  const panels = doc.objects.filter((object): object is PanelObject => object.type === 'panel' && !object.hidden)
  const rank = new Map(order.map((id, index) => [id, index]))
  const initial = panelGridReadingOrder(panels)
  return initial.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
}

function readPlan(doc: FigureDocument, render: RenderState, assets: AssetState, options?: Partial<PanelGridSettings>) {
  // Inspector drafts own layout controls, never the document's replay baseline.
  const settings = normalizePanelGridSettings({ ...doc.panelGrid, ...options, frames: doc.panelGrid?.frames }, doc.objects.filter((object) => object.type === 'panel' && !object.hidden).length)
  const panels = gridPanels(doc, settings.order)
  settings.order = panels.map((panel) => panel.id)
  return planPanelGrid({
    page: doc.page,
    panels,
    settings,
    resolveAxes: (panel) => {
      const manifest = exactPanelManifest(render, panel)
      if (manifest) return { status: 'ready', bounds: panelAxesBounds(panel, manifest) }
      if (assets.byId[panel.fileId]?.capability?.status === 'layout_only') return { status: 'ready', bounds: null }
      return { status: 'pending' }
    },
  })
}

export function readPanelGrid(options?: Partial<PanelGridSettings>) {
  return readPlan(useDocumentStore.getState().doc, useRenderStore.getState(), useAssetStore.getState(), options)
}

export function usePanelGrid() {
  const busy = useGridActivity((state) => state.busy)
  const doc = useDocumentStore((state) => state.doc)
  const byKey = useRenderStore((state) => state.byKey)
  const byId = useAssetStore((state) => state.byId)
  return useMemo(() => ({ ...readPlan(doc, { ...useRenderStore.getState(), byKey }, { ...useAssetStore.getState(), byId }), busy }), [doc, byKey, byId, busy])
}

/** Explicit preparation only. Merely opening the layout controls never runs a script. */
export function preparePanelGrid() {
  const doc = useDocumentStore.getState().doc
  for (const panel of gridPanels(doc)) {
    const state = useRenderStore.getState()
    if (exactPanelManifest(state, panel) || state.byKey[renderKeyOf(panel)]?.status === 'rendering') continue
    if (useAssetStore.getState().byId[panel.fileId]?.capability?.status === 'layout_only') continue
    requestRender(panel, 'immediate')
  }
}

/** One undo step owns settings, panel geometry and attached panel letters together. */
export async function applyPanelGrid(options: Partial<PanelGridSettings> = {}) {
  if (useGridActivity.getState().busy) return readPanelGrid(options)
  settleDocumentInput()
  let plan = readPanelGrid(options)
  const ui = useUiStore.getState()
  if (plan.status !== 'ready') {
    ui.setStatus(msg(`panelGrid.${plan.status === 'pending' ? 'pending' : plan.reason}`, undefined, 'inspector'))
    return plan
  }
  const before = useDocumentStore.getState().doc
  useGridActivity.setState({ busy: true })
  try {
    const prepared = await preparePlotFramePanels(before, plan.settings.ratio, plan.settings)
    if (prepared?.status === 'error') {
      ui.setStatus(msg(`panelGrid.${prepared.code}`, undefined, 'inspector'))
      return readPanelGrid(options)
    }
    const proposed = new Map(prepared?.panels.map((panel) => [panel.id, panel]) ?? [])
    if (prepared) {
      plan = planPanelGrid({
        page: before.page,
        panels: gridPanels(before, plan.settings.order).map((panel) => proposed.get(panel.id) ?? panel),
        settings: { ...plan.settings, frames: prepared.frames },
        resolveAxes: (panel) => {
          const manifest = prepared.manifests.get(panel.id)
          return { status: 'ready', bounds: manifest ? panelAxesBounds(panel, manifest) : null }
        },
      })
      if (plan.status !== 'ready') {
        ui.setStatus(msg(`panelGrid.${plan.status === 'pending' ? 'pending' : plan.reason}`, undefined, 'inspector'))
        return plan
      }
      if (!prepared.isCurrent()) {
        ui.setStatus(msg('panelGrid.changed', undefined, 'inspector'))
        return readPanelGrid(options)
      }
    }
    const labelObstacles = new Map<string, Rect[]>()
    for (const cell of plan.cells) {
      const source = proposed.get(cell.panelId)
      const manifest = prepared.manifests.get(cell.panelId)
      if (!source || !manifest || panelRotation(source) || source.flipH || source.flipV ||
        (source.crop && (source.crop.x !== 0 || source.crop.y !== 0 || source.crop.w !== 1 || source.crop.h !== 1))) continue
      const panel = { ...source, ...cell.panelBounds }
      const axes = manifest.elements.filter((el) => (el.role === 'axes' || el.role === 'axes3d') && !el.is_colorbar && !isElementHidden(el))
      labelObstacles.set(panel.id, manifest.elements.filter((el) =>
        ['axis_label', 'ticks', 'ticklabel', 'title'].includes(el.role) && !isElementHidden(el) &&
        // A tick-group union contains empty space between labels. Prefer the
        // individual text bounds when present for actual label collisions.
        !(el.role === 'ticks' && manifest.elements.some((tick) => tick.role === 'ticklabel' &&
          !isElementHidden(tick) && tick.gid.startsWith(el.gid.replace(/ticks$/, 'ticklabels_')))) &&
        axes.some((axis) => el.gid.startsWith(`${axis.gid}.`)))
        .map((el) => fracBoxToMm(panel, el.bbox)))
    }
    const labelPlan = planPanelGridLabelClearance(before.objects,
      planPanelGridLabels(before.objects, plan.patches, plan.cells), plan.cells, labelObstacles)
    if (labelPlan.blockedRows.length) {
      ui.setStatus(msg('panelGrid.font_layout_failed', undefined, 'inspector'))
      return readPanelGrid(options)
    }
    const labels = labelPlan.patches
    const settingsChanged = JSON.stringify(before.panelGrid) !== JSON.stringify(plan.settings)
    const overridesChanged = [...proposed.values()].some((panel) =>
      JSON.stringify(panel.overrides) !== JSON.stringify((before.objects.find((object) => object.id === panel.id) as PanelObject).overrides))
    if (settingsChanged || overridesChanged || plan.patches.length || labels.length) {
      const ready = plan
      useDocumentStore.getState().commit(msg('panelGrid.history', undefined, 'inspector'), (draft) => {
        draft.panelGrid = ready.settings
        for (const panel of proposed.values()) {
          const target = draft.objects.find((object): object is PanelObject => object.id === panel.id && object.type === 'panel')
          if (target) target.overrides = panel.overrides
        }
        for (const patch of [...ready.patches, ...labels]) {
          const target = draft.objects.find((object) => object.id === patch.id)
          if (target) Object.assign(target, patch)
        }
      })
    }
    ui.setShowGrid(true)
    ui.setStatus(prepared?.preserved.length
      ? msg('panelGrid.preserved', { count: prepared.preserved.length }, 'inspector')
      : msg('panelGrid.applied', { count: plan.cells.length }, 'inspector'))
    return plan
  } finally {
    useGridActivity.setState({ busy: false })
  }
}
