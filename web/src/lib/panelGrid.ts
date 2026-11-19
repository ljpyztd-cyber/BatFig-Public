import { panelRotation, rotationSwaps, type PanelObject, type PanelOverride } from '@/types/document'
import type { Rect } from './geometry'
import { sameAfterRound4 } from './axesLayout'

export type PanelGridAlign = 'start' | 'center' | 'end'

/** A stable input variant prevents repeated ratio changes from shrinking the frame. */
export interface PanelGridFrameBaseline {
  sourceKey: string
  baselineOverrides: PanelOverride[]
  appliedOverrides: PanelOverride[]
}

/** ratio describes the cell, never a stretch applied to the source figure. */
export interface PanelGridSettings {
  cols: number
  ratio: number
  gap: number
  margin: number
  /** Final page size, after the figure's uniform canvas scale. */
  axisFontSizePt: number
  basis: 'axes' | 'image'
  columnAlign: PanelGridAlign
  rowAlign: PanelGridAlign
  /** The document owner can retain its first reading order between reflows. */
  order?: string[]
  /** Last grid-owned variant and its original input; keyed by canvas panel id. */
  frames?: Record<string, PanelGridFrameBaseline>
}

export const DEFAULT_PANEL_GRID: Readonly<PanelGridSettings> = {
  cols: 1, ratio: 4 / 3, gap: 3, margin: 8, axisFontSizePt: 8,
  basis: 'axes', columnAlign: 'start', rowAlign: 'end',
}

/** Geometry floor only; fitting a grid does not certify publication typography. */
export const MIN_PANEL_GRID_CELL_MM = 10
const MIN_PANEL_SIDE_MM = 1
const GEOMETRY_EPSILON = 1e-7

function jsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || ancestors.has(value)) return false
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false
  ancestors.add(value)
  const valid = Object.values(value).every((part) => jsonValue(part, ancestors))
  ancestors.delete(value)
  return valid
}

function overrideList(value: unknown): value is PanelOverride[] {
  return Array.isArray(value) && value.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) &&
    typeof entry.gid === 'string' && entry.gid.trim().length > 0 &&
    typeof entry.prop === 'string' && entry.prop.trim().length > 0 && Object.hasOwn(entry, 'value') &&
    (!Object.hasOwn(entry, 'identity') || typeof entry.identity === 'string') && jsonValue(entry))
}

/** A malformed entry is discarded whole: partial override lists are another state. */
function normalizeFrameBaselines(raw: unknown): Record<string, PanelGridFrameBaseline> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const valid = Object.entries(raw).flatMap(([id, entry]: [string, unknown]) => {
    if (!id.trim() || !entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const value = entry as Partial<PanelGridFrameBaseline>
    if (typeof value.sourceKey !== 'string' || !value.sourceKey.trim() ||
      !overrideList(value.baselineOverrides) || !overrideList(value.appliedOverrides)) return []
    return [[id, {
      sourceKey: value.sourceKey,
      baselineOverrides: value.baselineOverrides.map((override) => ({ ...override })),
      appliedOverrides: value.appliedOverrides.map((override) => ({ ...override })),
    }] as const]
  })
  return valid.length ? Object.fromEntries(valid) : undefined
}

export function normalizePanelGridSettings(raw: unknown, visiblePanelCount?: number): PanelGridSettings {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Partial<PanelGridSettings> : {}
  const number = (v: unknown, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? v : fallback
  const align = (v: unknown, fallback: PanelGridAlign): PanelGridAlign =>
    v === 'start' || v === 'center' || v === 'end' ? v : fallback
  const count = visiblePanelCount !== undefined && Number.isFinite(visiblePanelCount)
    ? Math.max(1, Math.floor(visiblePanelCount)) : Number.MAX_SAFE_INTEGER
  const defaultCols = visiblePanelCount !== undefined && Number.isFinite(visiblePanelCount)
    ? Math.ceil(Math.sqrt(Math.max(1, visiblePanelCount))) : DEFAULT_PANEL_GRID.cols
  const ratio = number(value.ratio, DEFAULT_PANEL_GRID.ratio)
  const axisFontSizePt = number(value.axisFontSizePt, DEFAULT_PANEL_GRID.axisFontSizePt)
  const frames = normalizeFrameBaselines(value.frames)
  return {
    cols: Math.min(count, Math.max(1, Math.floor(number(value.cols, defaultCols)))),
    ratio: ratio > 0 ? ratio : DEFAULT_PANEL_GRID.ratio,
    gap: Math.max(0, number(value.gap, DEFAULT_PANEL_GRID.gap)),
    margin: Math.max(0, number(value.margin, DEFAULT_PANEL_GRID.margin)),
    axisFontSizePt: axisFontSizePt > 0 ? axisFontSizePt : DEFAULT_PANEL_GRID.axisFontSizePt,
    basis: value.basis === 'image' ? 'image' : 'axes',
    columnAlign: align(value.columnAlign, DEFAULT_PANEL_GRID.columnAlign),
    rowAlign: align(value.rowAlign, DEFAULT_PANEL_GRID.rowAlign),
    ...(Array.isArray(value.order) ? {
      order: [...new Set(value.order.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))],
    } : {}),
    ...(frames ? { frames } : {}),
  }
}

/** ready+null is explicitly known to have no visible axes; absence is pending. */
export type PanelGridAxes = { status: 'ready'; bounds: Rect | null } | { status: 'pending' }
export type PanelGridPatch = Rect & { id: string }
export interface PanelGridCell {
  panelId: string
  index: number
  row: number
  col: number
  bounds: Rect
  anchor: { x: number; y: number }
  panelBounds: Rect
  alignmentBounds: Rect
  basis: 'axes' | 'image'
}

interface PanelGridResultBase {
  settings: PanelGridSettings
  patches: PanelGridPatch[]
  cells: PanelGridCell[]
}
export type PanelGridPlan = PanelGridResultBase & (
  | {
    status: 'ready'
    rows: number
    cols: number
    cellW: number
    cellH: number
    grid: Rect
    anchors: { columns: number[]; rows: number[] }
    /** Additional common shrink needed to retain whole figures around their axes. */
    scale: number
    fallbackIds: string[]
  }
  | { status: 'pending'; pendingIds: string[] }
  | { status: 'blocked'; reason: 'locked' | 'group' | 'size' | 'invalid'; ids: string[] }
)

export interface PanelGridInput {
  page: { w: number; h: number }
  panels: readonly PanelObject[]
  settings?: Partial<PanelGridSettings>
  /** Caller resolves only current exact geometry, never a display fallback. */
  resolveAxes?: (panel: PanelObject) => PanelGridAxes
  /** Default input order lets the document owner preserve an explicit order. */
  order?: 'input' | 'reading'
}

const validRect = (r: Rect) => [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0
const fraction = (align: PanelGridAlign) => align === 'start' ? 0 : align === 'center' ? 0.5 : 1
const clampUnit = (value: number) => Math.max(0, Math.min(1, value))

/**
 * Initial grid order follows visible figure rows, not a fixed millimetre band.
 * A row needs at least half of the shorter picture's height in common for every
 * pair. Requiring every pair prevents an overlapping middle picture from joining
 * two separate rows transitively. Source arrays and retained document order are
 * never changed; ambiguous overlapping figures use their centres deterministically.
 */
export function panelGridReadingOrder<T extends Rect>(panels: readonly T[]): T[] {
  const entries = panels.map((panel, index) => ({ panel, index, center: panel.y + panel.h / 2 }))
  const valid = entries.filter(({ panel }) => validRect(panel))
    .sort((a, b) => a.center - b.center || a.panel.y - b.panel.y || a.index - b.index)
  const rows: typeof entries[] = []
  for (const entry of valid) {
    const compatible = rows.filter((row) => row.every(({ panel }) =>
      Math.min(panel.y + panel.h, entry.panel.y + entry.panel.h) - Math.max(panel.y, entry.panel.y) >=
      Math.min(panel.h, entry.panel.h) / 2 - GEOMETRY_EPSILON))
    // A tall inset can overlap several rows; use the closest row centre rather
    // than merge those rows. The all-pairs condition remains the membership gate.
    const centerOf = (row: typeof entries) => row.reduce((sum, member) => sum + member.center, 0) / row.length
    const row = compatible.sort((a, b) => Math.abs(centerOf(a) - entry.center) - Math.abs(centerOf(b) - entry.center))[0]
    if (row) row.push(entry)
    else rows.push([entry])
  }
  return [
    ...rows.flatMap((row) => row.sort((a, b) => a.panel.x - b.panel.x || a.index - b.index).map(({ panel }) => panel)),
    // The planner rejects invalid geometry; keep those entries for that decision.
    ...entries.filter(({ panel }) => !validRect(panel)).map(({ panel }) => panel),
  ]
}

/** Restore the native figure aspect, retaining its crop and quarter-turn rotation. */
function sourceSize(panel: PanelObject): { w: number; h: number } | null {
  if (!validRect(panel) || ![panel.nativeW, panel.nativeH].every((n) => Number.isFinite(n) && n > 0)) return null
  const crop = panel.crop ?? { x: 0, y: 0, w: 1, h: 1 }
  if (!validRect(crop) || crop.x < 0 || crop.y < 0 || crop.x + crop.w > 1 + GEOMETRY_EPSILON || crop.y + crop.h > 1 + GEOMETRY_EPSILON) return null
  const w = panel.nativeW * crop.w
  const h = panel.nativeH * crop.h
  return rotationSwaps(panelRotation(panel)) ? { w: h, h: w } : { w, h }
}

/**
 * Pure all-or-nothing layout. Every source is contained at its native aspect.
 * Initial contained figures give left/right extents around each column anchor
 * and top/bottom extents around each row anchor. Their maximum envelopes may
 * exceed one nominal cell; a common shrink fits all envelopes before placing
 * anything. Pack those complete envelopes with the requested gap, without
 * retaining unused nominal-cell space. Entire pictures (including their blank
 * margins, legends and colorbars) stay separate, while each chosen axes line
 * is shared precisely by its column/row peers.
 */
export function planPanelGrid(input: PanelGridInput): PanelGridPlan {
  const visible = input.panels.filter((panel) => !panel.hidden)
  const panels = input.order === 'reading' ? panelGridReadingOrder(visible) : visible
  const settings = normalizePanelGridSettings(input.settings, panels.length)
  const blocked = (reason: 'locked' | 'group' | 'size' | 'invalid', ids: string[] = []): PanelGridPlan =>
    ({ status: 'blocked', reason, ids, settings, patches: [], cells: [] })
  if (!panels.length || ![input.page.w, input.page.h].every((n) => Number.isFinite(n) && n > 0)) return blocked('invalid')
  const duplicates = panels.filter((panel, i) => panels.findIndex((other) => other.id === panel.id) !== i)
  if (duplicates.length) return blocked('invalid', duplicates.map((panel) => panel.id))
  const locked = panels.filter((panel) => panel.locked || panel.layoutPinned)
  if (locked.length) return blocked('locked', locked.map((panel) => panel.id))
  const grouped = panels.filter((panel) => panel.groupId)
  if (grouped.length) return blocked('group', grouped.map((panel) => panel.id))

  const cols = settings.cols
  const rows = Math.ceil(panels.length / cols)
  const availableW = input.page.w - 2 * settings.margin - (cols - 1) * settings.gap
  const availableH = input.page.h - 2 * settings.margin - (rows - 1) * settings.gap
  const cellW = Math.min(availableW / cols, availableH / rows * settings.ratio)
  const cellH = cellW / settings.ratio
  if (![cellW, cellH].every(Number.isFinite) || Math.min(cellW, cellH) < MIN_PANEL_GRID_CELL_MM) return blocked('size')
  const columns = Array.from({ length: cols }, () => ({ before: 0, after: 0 }))
  const rowExtents = Array.from({ length: rows }, () => ({ before: 0, after: 0 }))
  const pendingIds: string[] = []
  const invalidIds: string[] = []
  const fallbackIds: string[] = []
  const measures: { panel: PanelObject; row: number; col: number; w: number; h: number; ax: number; ay: number; normalized: Rect; basis: 'axes' | 'image' }[] = []

  panels.forEach((panel, index) => {
    const size = sourceSize(panel)
    if (!size) { invalidIds.push(panel.id); return }
    const geometry = settings.basis === 'axes' ? input.resolveAxes?.(panel) ?? { status: 'pending' as const } : null
    if (geometry?.status === 'pending') { pendingIds.push(panel.id); return }
    const axes = geometry?.bounds ?? null
    const bounds = axes ?? panel
    if (!validRect(bounds) || bounds.x < panel.x - GEOMETRY_EPSILON || bounds.y < panel.y - GEOMETRY_EPSILON ||
      bounds.x + bounds.w > panel.x + panel.w + GEOMETRY_EPSILON || bounds.y + bounds.h > panel.y + panel.h + GEOMETRY_EPSILON) {
      invalidIds.push(panel.id); return
    }
    if (settings.basis === 'axes' && !axes) fallbackIds.push(panel.id)
    const nx = clampUnit((bounds.x - panel.x) / panel.w)
    const ny = clampUnit((bounds.y - panel.y) / panel.h)
    const normalized = { x: nx, y: ny, w: clampUnit(bounds.w / panel.w), h: clampUnit(bounds.h / panel.h) }
    // Size from the plotting frame. External colorbars/legends only contribute
    // to the shared envelope below, so they cannot shrink just one main plot.
    const fit = Math.min(cellW / (size.w * normalized.w), cellH / (size.h * normalized.h))
    const w = size.w * fit
    const h = size.h * fit
    const ax = (normalized.x + normalized.w * fraction(settings.columnAlign)) * w
    const ay = (normalized.y + normalized.h * fraction(settings.rowAlign)) * h
    const row = Math.floor(index / cols)
    const col = index % cols
    columns[col].before = Math.max(columns[col].before, ax)
    columns[col].after = Math.max(columns[col].after, w - ax)
    rowExtents[row].before = Math.max(rowExtents[row].before, ay)
    rowExtents[row].after = Math.max(rowExtents[row].after, h - ay)
    measures.push({ panel, row, col, w, h, ax, ay, normalized, basis: axes ? 'axes' : 'image' })
  })
  if (invalidIds.length) return blocked('invalid', invalidIds)
  if (pendingIds.length) return { status: 'pending', pendingIds, settings, patches: [], cells: [] }

  const scale = Math.min(1,
    ...columns.map((column) => cellW / (column.before + column.after)),
    ...rowExtents.map((row) => cellH / (row.before + row.after)),
  )
  if (!Number.isFinite(scale) || measures.some((m) => Math.min(m.w, m.h) * scale < MIN_PANEL_SIDE_MM)) return blocked('size')
  // Keep the established scale, then remove only unused space between complete
  // envelopes. Do not enlarge again: that would add visible internal margins
  // back to the gaps the user just reduced. cellW/H remain the nominal fit box;
  // cells.bounds below records each actual occupied column/row slot.
  const columnWidths = columns.map((column) => (column.before + column.after) * scale)
  const rowHeights = rowExtents.map((row) => (row.before + row.after) * scale)
  const gridW = columnWidths.reduce((sum, width) => sum + width, 0) + settings.gap * (cols - 1)
  const gridH = rowHeights.reduce((sum, height) => sum + height, 0) + settings.gap * (rows - 1)
  const grid = { x: (input.page.w - gridW) / 2, y: (input.page.h - gridH) / 2, w: gridW, h: gridH }
  const starts = (sizes: number[], origin: number) => {
    let next = origin
    return sizes.map((size) => {
      const start = next
      next += size + settings.gap
      return start
    })
  }
  const columnStarts = starts(columnWidths, grid.x)
  const rowStarts = starts(rowHeights, grid.y)
  const anchors = {
    columns: columns.map((column, col) => columnStarts[col] + column.before * scale),
    rows: rowExtents.map((row, index) => rowStarts[index] + row.before * scale),
  }
  const patches: PanelGridPatch[] = []
  const cells: PanelGridCell[] = []
  for (const m of measures) {
    const w = m.w * scale
    const h = m.h * scale
    const anchor = { x: anchors.columns[m.col], y: anchors.rows[m.row] }
    const panelBounds = { x: anchor.x - m.ax * scale, y: anchor.y - m.ay * scale, w, h }
    const previous = [m.panel.x, m.panel.y, m.panel.w, m.panel.h]
    const next = [panelBounds.x, panelBounds.y, w, h]
    // Recomputed dimensions can straddle an exact rounding half-step by a
    // machine epsilon; that is not a new geometry edit or an undo step.
    if (!previous.every((value, index) => Math.abs(value - next[index]) < GEOMETRY_EPSILON) && !sameAfterRound4(previous, next)) {
      patches.push({ id: m.panel.id, ...panelBounds })
    }
    cells.push({
      panelId: m.panel.id, index: cells.length, row: m.row, col: m.col, anchor, panelBounds,
      bounds: { x: columnStarts[m.col], y: rowStarts[m.row], w: columnWidths[m.col], h: rowHeights[m.row] },
      alignmentBounds: { x: panelBounds.x + m.normalized.x * w, y: panelBounds.y + m.normalized.y * h, w: m.normalized.w * w, h: m.normalized.h * h },
      basis: m.basis,
    })
  }
  return { status: 'ready', settings, patches, cells, rows, cols, cellW, cellH, grid, anchors, scale, fallbackIds }
}
