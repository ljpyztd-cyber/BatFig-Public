import type { Manifest } from '@/lib/api'
import { panelAxesBounds } from '@/lib/canvasAlignment'
import { currentContentKey } from '@/lib/documentCheckpoint'
import { effectiveOverride, upsertOverrides } from '@/lib/effectiveOverride'
import { stampOverrideIdentities } from '@/lib/overrideIdentity'
import { normalizePanelGridSettings, panelGridReadingOrder, planPanelGrid, type PanelGridFrameBaseline, type PanelGridSettings } from '@/lib/panelGrid'
import { planPanelGridTypography, type PanelGridTypographyTarget } from '@/lib/panelGridTypography'
import { planPanelGridTextPadding } from '@/lib/panelGridTextPadding'
import { planPlotFrame } from '@/lib/plotFrameLayout'
import { currentProjectId } from '@/lib/session'
import { panelRotation, type FigureDocument, type PanelObject } from '@/types/document'
import { useAssetStore } from './assetStore'
import { useDocumentStore } from './documentStore'
import { exactPanelManifest, renderEpoch, renderKeyOf, useRenderStore } from './renderStore'

export interface PlotFramePrepareError {
  status: 'error'
  code: 'changed' | 'geometry_pending' | 'render_failed' | 'geometry_mismatch' | 'font_size_invalid' | 'font_size_unsupported' | 'font_size_mismatch' | 'font_layout_failed'
  message: string
  panelId?: string
}

export interface PreparedPlotFrames {
  status: 'ready'
  panels: PanelObject[]
  manifests: Map<string, Manifest>
  frames: Record<string, PanelGridFrameBaseline>
  preserved: { id: string; reason?: string }[]
  /** Check immediately before the caller's single document commit. */
  isCurrent: () => boolean
}

const failure = (code: PlotFramePrepareError['code'], message: string, panelId?: string): PlotFramePrepareError =>
  ({ status: 'error', code, message, ...(panelId ? { panelId } : {}) })

/** Canvas placement is deliberately absent: moving/scaling a panel does not replace its plot. */
export function plotFrameSourceKey(panel: PanelObject): string {
  return JSON.stringify({
    fileId: panel.fileId, fileKind: panel.fileKind, script: panel.script ?? null,
    nativeW: panel.nativeW, nativeH: panel.nativeH, source: panel.source ?? null,
    crop: panel.crop ?? { x: 0, y: 0, w: 1, h: 1 }, rotation: panelRotation(panel),
    flipH: !!panel.flipH, flipV: !!panel.flipV, lockedGids: [...(panel.lockedGids ?? [])].sort(),
  })
}

/**
 * Prepare real rendered variants without changing the document. The caller owns
 * the final all-or-nothing layout commit. Subscriptions remember intervening
 * edits even when an undo or cancelled gesture returns to the original content.
 */
export async function preparePlotFramePanels(doc: FigureDocument, ratio: number, gridSettings?: PanelGridSettings): Promise<PreparedPlotFrames | PlotFramePrepareError> {
  const initial = useDocumentStore.getState()
  const content = currentContentKey(initial)
  const epoch = renderEpoch()
  const project = currentProjectId()
  const savedSettings = normalizePanelGridSettings(doc.panelGrid)
  const panels = doc.objects.filter((object): object is PanelObject => object.type === 'panel' && !object.hidden)
    .map((panel) => structuredClone(panel))
  const manifests = new Map<string, Manifest>()
  let invalidated = false
  const isCurrent = () => {
    const now = useDocumentStore.getState()
    const renders = useRenderStore.getState()
    if (invalidated || renderEpoch() !== epoch || currentProjectId() !== project || now.txn ||
      now.documentId !== initial.documentId || now.loadSeq !== initial.loadSeq || now.activeCanvasId !== initial.activeCanvasId ||
      currentContentKey(now) !== content || panels.some((panel) => {
        const expected = manifests.get(panel.id)
        return expected !== undefined && exactPanelManifest(renders, panel) !== expected
      })) invalidated = true
    return !invalidated
  }
  if (!Number.isFinite(ratio) || ratio <= 0) return failure('geometry_mismatch', 'Invalid plotting-frame aspect ratio')
  if (currentContentKey({ ...initial, doc }) !== content || !isCurrent()) return failure('changed', 'Document changed before plot-frame preparation')

  const changedError = () => failure('changed', 'Document or project changed during plot-frame preparation')
  const unsubDocument = useDocumentStore.subscribe(() => { isCurrent() })
  const unsubEpoch = useRenderStore.subscribe(() => { isCurrent() })
  const frames: Record<string, PanelGridFrameBaseline> = {}
  const preserved: PreparedPlotFrames['preserved'] = []
  const jobs: { panel: PanelObject; before: Manifest }[] = []

  const renderExact = (panel: PanelObject): Promise<Manifest> => new Promise((resolve, reject) => {
    let settled = false
    let unsubscribeRender = () => {}
    let unsubscribeDocument = () => {}
    const finish = (error?: PlotFramePrepareError, manifest?: Manifest) => {
      if (settled) return
      settled = true
      unsubscribeRender()
      unsubscribeDocument()
      if (error) reject(error)
      else resolve(manifest!)
    }
    const inspect = () => {
      if (!isCurrent()) { finish(changedError()); return }
      const state = useRenderStore.getState()
      const own = state.byKey[renderKeyOf(panel)]
      if (own?.status === 'error') {
        finish(failure('render_failed', own.code || 'Plot-frame render failed', panel.id))
        return
      }
      const manifest = exactPanelManifest(state, panel)
      if (own?.status !== 'ready' || !manifest || own.previewDpi != null) return
      if (own.warnings.length || state.inconsistent[panel.fileId]) {
        finish(failure('render_failed', own.warnings.join('\n') || 'Figure replay is inconsistent', panel.id))
      } else finish(undefined, manifest)
    }
    // render() can return immediately when this exact variant is already busy.
    // Observe its real completion rather than treating that return as success.
    unsubscribeRender = useRenderStore.subscribe(inspect)
    unsubscribeDocument = useDocumentStore.subscribe(inspect)
    try {
      void useRenderStore.getState().render(panel.fileId, panel.overrides, undefined, 'immediate', epoch)
        .then(inspect, (error: unknown) => finish(failure('render_failed', String(error), panel.id)))
      inspect()
    } catch (error) {
      finish(failure('render_failed', String(error), panel.id))
    }
  })

  try {
    for (const panel of panels) {
      const manifest = exactPanelManifest(useRenderStore.getState(), panel)
      if (!manifest) {
        if (useAssetStore.getState().byId[panel.fileId]?.capability?.status === 'layout_only') {
          preserved.push({ id: panel.id, reason: 'layout_only' })
          continue
        }
        return failure('geometry_pending', 'Exact plotting geometry is not ready', panel.id)
      }
      manifests.set(panel.id, manifest)
      jobs.push({ panel, before: manifest })
    }
    let cursor = 0
    let error: PlotFramePrepareError | null = null
    const work = async () => {
      while (cursor < jobs.length && !error) {
        if (!isCurrent()) { error = changedError(); return }
        const { panel, before } = jobs[cursor++]
        try {
          if (gridSettings?.basis === 'image') {
            const saved = savedSettings.frames?.[panel.id]
            if (saved?.sourceKey === plotFrameSourceKey(panel) &&
              JSON.stringify(panel.overrides) === JSON.stringify(saved.appliedOverrides)) frames[panel.id] = structuredClone(saved)
            continue
          }
          const sourceKey = plotFrameSourceKey(panel)
          const saved = savedSettings.frames?.[panel.id]
          const reuse = saved?.sourceKey === sourceKey && Array.isArray(saved.baselineOverrides) &&
            JSON.stringify(panel.overrides) === JSON.stringify(saved.appliedOverrides)
          // Gap/alignment-only edits and a repeated Apply after reopening need
          // no baseline render when this exact frame already has the ratio.
          if (reuse && savedSettings.ratio === ratio) {
            const currentPlan = planPlotFrame(panel, before, ratio)
            if (currentPlan.status === 'ready' && !currentPlan.changed) {
              frames[panel.id] = structuredClone(saved)
              continue
            }
          }
          const baseline = { ...panel, overrides: structuredClone(reuse ? saved.baselineOverrides : panel.overrides) }
          const baselineManifest = exactPanelManifest(useRenderStore.getState(), baseline) ?? await renderExact(baseline)
          if (!isCurrent()) { error = changedError(); return }
          if (baselineManifest.size_mm.some((size, index) => Math.abs(size - before.size_mm[index]) > 1e-4)) {
            error = failure('geometry_mismatch', 'Baseline source figure dimensions changed', panel.id)
            return
          }
          const plan = planPlotFrame(baseline, baselineManifest, ratio)
          if (plan.status === 'preserve') {
            preserved.push({ id: panel.id, reason: plan.reason })
            continue
          }
          const candidate = { ...panel, overrides: structuredClone(plan.overrides) }
          if (reuse) {
            // Baseline font entries may predate regenerated position entries.
            // Keep the live variant's established order across ratio round trips.
            const ranks = new Map(panel.overrides.map((entry, index) => [`${entry.gid}\0${entry.prop}`, index]))
            candidate.overrides.sort((a, b) => (ranks.get(`${a.gid}\0${a.prop}`) ?? Infinity) -
              (ranks.get(`${b.gid}\0${b.prop}`) ?? Infinity))
          }
          // Use the same identity writer as documentStore before rendering, so
          // its final commit cannot change the variant that was verified here.
          const proposedDoc = { ...doc, objects: doc.objects.map((object) => object.id === panel.id ? candidate : object) }
          stampOverrideIdentities(proposedDoc, doc, proposedDoc, () => baselineManifest)
          const changed = JSON.stringify(candidate.overrides) !== JSON.stringify(panel.overrides)
          const manifest = changed ? await renderExact(candidate) : before
          if (!isCurrent()) { error = changedError(); return }
          // Compare native physical geometry: existing canvas panels may have
          // been stretched, while the grid restores their source aspect later.
          const bounds = panelAxesBounds({ ...panel, w: panel.nativeW, h: panel.nativeH }, manifest)
          const sameSize = manifest.size_mm.every((size, index) => Math.abs(size - before.size_mm[index]) <= 1e-4)
          // Both persisted positions and returned bbox coordinates are round4.
          // Three fractional quanta cover the two rounding stages, not a loose
          // visual tolerance that could hide a fixed-aspect axis rejecting edits.
          const tolerance = 3e-4 * (panel.nativeW + ratio * panel.nativeH)
          if (changed && (!sameSize || !bounds || Math.abs(bounds.w - ratio * bounds.h) > tolerance)) {
            error = failure('geometry_mismatch', 'Rendered plotting frame does not match the requested geometry', panel.id)
            return
          }
          panel.overrides = candidate.overrides
          manifests.set(panel.id, manifest)
          frames[panel.id] = {
            sourceKey,
            baselineOverrides: structuredClone(baseline.overrides),
            appliedOverrides: structuredClone(candidate.overrides),
          }
        } catch (caught) {
          error = caught && typeof caught === 'object' && 'status' in caught && caught.status === 'error'
            ? caught as PlotFramePrepareError : failure('render_failed', String(caught), panel.id)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, () => work()))
    if (!isCurrent()) return changedError()
    if (error) return error
    if (gridSettings) {
      // The grid decides the final uniform figure scale. Render its typography
      // before committing; font-sensitive layouts can require another fit.
      const rank = new Map((gridSettings.order ?? []).map((id, index) => [id, index]))
      const ordered = panelGridReadingOrder(panels).sort((a, b) =>
        (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
      let verified = false
      for (let pass = 0; pass < 12; pass++) {
        if (!isCurrent()) return changedError()
        const layout = planPanelGrid({
          page: doc.page, panels: ordered, settings: gridSettings,
          resolveAxes: (panel) => ({ status: 'ready', bounds: manifests.has(panel.id)
            ? panelAxesBounds(panel, manifests.get(panel.id)!) : null }),
        })
        if (layout.status !== 'ready') return failure('geometry_mismatch', 'Prepared grid no longer fits the page')
        const candidates: { panel: PanelObject; before: Manifest; candidate: PanelObject; targets: PanelGridTypographyTarget[]; paddingChanged: boolean }[] = []
        for (const cell of layout.cells) {
          const panel = panels.find((item) => item.id === cell.panelId)!
          const before = manifests.get(panel.id)
          if (!before) continue // Explicit layout-only assets have no editable axis text.
          const finalPanel = { ...panel, ...cell.panelBounds }
          const typography = planPanelGridTypography(finalPanel, before, gridSettings.axisFontSizePt)
          if (typography.status === 'error') return failure(typography.code, typography.message, panel.id)
          // The returned manifest, not the override intent, proves the size.
          const matches = typography.targets.every((target) => {
            const actual = before.elements.find((el) => el.gid === target.gid)?.editable.find((field) => field.prop === target.prop)?.value
            return typeof actual === 'number' && Math.abs(actual - target.scriptSizePt) < 1e-5
          })
          let nextOverrides = typography.overrides
          if (!typography.changed) {
            if (!matches) return failure('font_size_mismatch', 'Rendered axis text does not match its font override', panel.id)
            // Measure actual glyph bounds only after the requested font has
            // rendered. Leave room before the final source-page clip/export.
            const padding = planPanelGridTextPadding(finalPanel, before)
            if (padding.status === 'error') return failure('font_layout_failed', padding.message, panel.id)
            if (!padding.changed) continue
            nextOverrides = padding.overrides
          }
          const candidate = { ...panel, overrides: structuredClone(nextOverrides) }
          const proposedDoc = { ...doc, objects: doc.objects.map((object) => object.id === panel.id ? candidate : object) }
          stampOverrideIdentities(proposedDoc, doc, proposedDoc, () => before)
          candidates.push({ panel, before, candidate, targets: typography.targets, paddingChanged: !typography.changed })
        }
        if (!candidates.length) { verified = true; break }
        // Bound concurrency just like plotting-frame preparation.
        let fontCursor = 0
        let fontError: PlotFramePrepareError | null = null
        const renderFonts = async () => {
          while (fontCursor < candidates.length && !fontError) {
            const { panel, before, candidate, targets, paddingChanged } = candidates[fontCursor++]
            try {
              const manifest = await renderExact(candidate)
              if (!isCurrent()) { fontError = changedError(); return }
              if (manifest.size_mm.some((size, index) => Math.abs(size - before.size_mm[index]) > 1e-4)) {
                fontError = failure('geometry_mismatch', 'Font change altered source figure dimensions', panel.id)
                return
              }
              if (gridSettings.basis === 'axes' && frames[panel.id]) {
                const bounds = panelAxesBounds({ ...panel, w: panel.nativeW, h: panel.nativeH }, manifest)
                const tolerance = 3e-4 * (panel.nativeW + ratio * panel.nativeH)
                if (!bounds || Math.abs(bounds.w - ratio * bounds.h) > tolerance) {
                  fontError = failure('geometry_mismatch', 'Font change altered the prepared plotting-frame aspect', panel.id)
                  return
                }
              }
              const matches = targets.every((target) => {
                const actual = manifest.elements.find((el) => el.gid === target.gid)?.editable.find((field) => field.prop === target.prop)?.value
                return typeof actual === 'number' && Math.abs(actual - target.scriptSizePt) < 1e-5
              })
              if (!matches) { fontError = failure('font_size_mismatch', 'Renderer did not apply the requested axis font size', panel.id); return }
              const previousOverrides = panel.overrides
              panel.overrides = candidate.overrides
              manifests.set(panel.id, manifest)
              const frame = frames[panel.id] ?? (paddingChanged ? frames[panel.id] = {
                sourceKey: plotFrameSourceKey(panel),
                baselineOverrides: structuredClone(previousOverrides),
                appliedOverrides: [],
              } : undefined)
              if (frame) {
                // Carry font edits into the source baseline too. Keep its
                // original axes positions for reversible ratio changes.
                const baseline = { overrides: structuredClone(frame.baselineOverrides) }
                upsertOverrides(baseline, targets.flatMap((target) => {
                  const override = effectiveOverride(candidate.overrides, target.gid, target.prop)
                  return override ? [override] : []
                }))
                frame.baselineOverrides = baseline.overrides
                frame.appliedOverrides = structuredClone(candidate.overrides)
              }
            } catch (caught) {
              fontError = caught && typeof caught === 'object' && 'status' in caught && caught.status === 'error'
                ? caught as PlotFramePrepareError : failure('render_failed', String(caught), panel.id)
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(2, candidates.length) }, () => renderFonts()))
        if (!isCurrent()) return changedError()
        if (fontError) return fontError
      }
      if (!verified) return failure('font_layout_failed', 'Font-sensitive layout did not converge to the requested page size')
    }
    // Promise completion order must not become persisted object-key order:
    // otherwise an identical second application creates a spurious undo step.
    const orderedFrames = Object.fromEntries(doc.objects.filter((object): object is PanelObject => object.type === 'panel')
      .flatMap((panel) => {
        const frame = panel.hidden ? savedSettings.frames?.[panel.id] : frames[panel.id]
        return frame ? [[panel.id, structuredClone(frame)]] : []
      }))
    return { status: 'ready', panels, manifests, frames: orderedFrames, preserved, isCurrent }
  } catch (error) {
    return failure('render_failed', String(error))
  } finally {
    unsubDocument()
    unsubEpoch()
  }
}
