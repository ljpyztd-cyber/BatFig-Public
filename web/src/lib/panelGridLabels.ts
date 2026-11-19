import type { CanvasObject, PanelObject, TextObject } from '@/types/document'
import type { Rect } from './geometry'
import { isSubLabel } from './stylePresets'
import { sameAfterRound4 } from './axesLayout'

export interface PanelGridLabelPanelPatch extends Rect { id: string }
export interface PanelGridLabelCell { panelId: string; bounds: Rect }
export type PanelGridLabelPatch = Pick<TextObject, 'id' | 'x' | 'y' | 'panelLabelFor'>

/** One inset for every row/column, independent of figure margins and outside legends. */
export const PANEL_LABEL_INSET = { x: 1.5, y: 1 } as const

const validRect = (rect: Rect) =>
  [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) && rect.w > 0 && rect.h > 0
const movableText = (text: TextObject) =>
  !text.hidden && !text.locked && !text.groupId && !text.layoutPinned && validRect(text)

/** The existing (a) rule also recognizes the historical bare a--i panel letters. */
function legacyLabel(text: TextObject): boolean {
  return isSubLabel(text) || isSubLabel({ ...text, text: `(${text.text.trim()})` })
}

function nearTopLeft(text: TextObject, panel: PanelObject): boolean {
  return Math.abs(text.x - panel.x) <= Math.min(10, panel.w * 0.2)
    && Math.abs(text.y - panel.y) <= Math.min(10, panel.h * 0.2)
}

/** Keep the unchanged-size label, including its rotated visual bounds, inside its cell. */
function positionInCell(text: TextObject, x: number, y: number, cell: Rect) {
  const angle = (text.rotationDeg ?? 0) * Math.PI / 180
  const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle))
  const dx = (text.w * c + text.h * s - text.w) / 2
  const dy = (text.w * s + text.h * c - text.h) / 2
  const minX = cell.x + dx, maxX = cell.x + cell.w - text.w - dx
  const minY = cell.y + dy, maxY = cell.y + cell.h - text.h - dy
  // A label that cannot fit must stay put; shrinking its font/box would change user content.
  if (![minX, maxX, minY, maxY].every(Number.isFinite) || minX > maxX || minY > maxY) return null
  return { x: Math.min(maxX, Math.max(minX, x)), y: Math.min(maxY, Math.max(minY, y)) }
}

/**
 * Pure geometry plan: grid labels share the same cell inset. Without cells, explicit
 * bindings follow their panel. Historical bare/(a) letters
 * are attached only when both label→panel and panel→label are unambiguous. Merely reading
 * a document never runs this helper; the caller commits bindings and positions together.
 */
export function planPanelGridLabels(
  objects: readonly CanvasObject[],
  panelPatches: readonly PanelGridLabelPanelPatch[],
  cells?: readonly PanelGridLabelCell[],
): PanelGridLabelPatch[] {
  const panels = objects.filter((object): object is PanelObject =>
    object.type === 'panel' && !object.hidden && validRect(object))
  const panelById = new Map(panels.map((panel) => [panel.id, panel]))
  const patches = new Map(panelPatches.filter(validRect).map((patch) => [patch.id, patch]))
  const cellByPanel = new Map(cells?.map((cell) => [cell.panelId, cell.bounds]))
  const texts = objects.filter((object): object is TextObject => object.type === 'text')
  const boundPanels = new Set(texts.map((text) => text.panelLabelFor).filter(Boolean))
  const inferred = new Map<string, string>()
  const candidateCount = new Map<string, number>()
  for (const text of texts) {
    if (text.panelLabelFor !== undefined || text.hidden
      || text.rotationDeg || !validRect(text) || !legacyLabel(text)) continue
    const nearby = panels.filter((panel) => nearTopLeft(text, panel))
    for (const panel of nearby) candidateCount.set(panel.id, (candidateCount.get(panel.id) ?? 0) + 1)
    if (!movableText(text) || nearby.length !== 1 || boundPanels.has(nearby[0].id)) continue
    const id = nearby[0].id
    inferred.set(text.id, id)
  }
  const result: PanelGridLabelPatch[] = []
  for (const text of texts) {
    if (!movableText(text)) continue
    const panelId = text.panelLabelFor ?? inferred.get(text.id)
    if (!panelId || (text.panelLabelFor === undefined && candidateCount.get(panelId) !== 1)) continue
    const previous = panelById.get(panelId)
    // An idempotent layout omits unchanged panel patches, but its cells still include them.
    const next = patches.get(panelId) ?? (cellByPanel.has(panelId) ? previous : undefined)
    if (!previous || previous.locked || !next) continue
    const cell = cells ? cellByPanel.get(panelId) : next
    if (!cell || !validRect(cell)) continue
    // Rotated labels retain their visual placement; aligning their unrotated boxes
    // would not align the visible lettering. Oversized labels stay put, never clamp
    // individual grid letters onto different row/column lines.
    const gridPosition = cells && !text.rotationDeg
      ? { x: cell.x + PANEL_LABEL_INSET.x, y: cell.y + PANEL_LABEL_INSET.y } : null
    const position = positionInCell(text,
      gridPosition?.x ?? next.x + (text.x - previous.x) * next.w / previous.w,
      gridPosition?.y ?? next.y + (text.y - previous.y) * next.h / previous.h, cell)
    if (!position) continue
    if (gridPosition && !sameAfterRound4([position.x, position.y], [gridPosition.x, gridPosition.y])) continue
    if (!sameAfterRound4([position.x, position.y], [text.x, text.y]) || text.panelLabelFor !== panelId) {
      result.push({ id: text.id, ...position, panelLabelFor: panelId })
    }
  }
  return result
}
