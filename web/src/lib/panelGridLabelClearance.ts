import type { CanvasObject, TextObject } from '@/types/document'
import { round4, sameAfterRound4 } from './axesLayout'
import type { Rect } from './geometry'
import type { PanelGridCell } from './panelGrid'
import type { PanelGridLabelPatch } from './panelGridLabels'

type ClearanceCell = Pick<PanelGridCell, 'panelId' | 'row' | 'col' | 'bounds'>
type BlockReason = 'locked' | 'invalid_geometry' | 'no_space'
export interface PanelGridLabelClearancePlan {
  patches: PanelGridLabelPatch[]
  blockedRows: { row: number; reason: BlockReason }[]
  shifts: { row: number; dy: number }[]
  columnShifts: { col: number; dx: number }[]
}
const GAP_MM = 0.3
const EPS = 1e-7
const valid = (box: Rect) => [box.x, box.y, box.w, box.h].every(Number.isFinite) && box.w > 0 && box.h > 0
type Direction = 'x' | 'y'
const collides = (label: Rect, obstacle: Rect, direction: Direction, amount: number) => {
  const x = label.x - (direction === 'x' ? amount : 0)
  const y = label.y - (direction === 'y' ? amount : 0)
  return x < obstacle.x + obstacle.w - EPS && x + label.w > obstacle.x + EPS &&
    y < obstacle.y + obstacle.h - EPS && y + label.h > obstacle.y + EPS
}

function displacement(labels: readonly Rect[], obstacles: readonly Rect[], direction: Direction, maximum: number): number | null {
  const extent = direction === 'x' ? 'w' : 'h'
  let amount = 0
  // Use the complete label extent, not the intersection size: a short tick can
  // be completely inside the label. Recheck any new obstacle entered by a move.
  for (let pass = 0; pass <= labels.length * obstacles.length; pass++) {
    const hits = labels.flatMap((label) => obstacles.filter((obstacle) => collides(label, obstacle, direction, amount))
      .map((obstacle) => label[direction] + label[extent] - obstacle[direction] + GAP_MM))
    if (!hits.length) return amount
    amount = Math.max(amount, ...hits)
    if (amount > maximum + EPS) return null
  }
  return null
}

/**
 * Merge the ordinary label plan with measured text clearance before committing.
 * First move a complete column left by the minimum safe distance. If horizontal
 * space is insufficient, move the affected complete row up. Previous complete
 * cell envelopes and page edges are hard bounds; failed plans are atomic.
 */
export function planPanelGridLabelClearance(
  objects: readonly CanvasObject[],
  plannedLabels: readonly PanelGridLabelPatch[],
  cells: readonly ClearanceCell[],
  obstaclesByPanel: ReadonlyMap<string, readonly Rect[]>,
): PanelGridLabelClearancePlan {
  const proposals = new Map(plannedLabels.map((patch) => [patch.id, patch]))
  const cellByPanel = new Map(cells.map((cell) => [cell.panelId, cell]))
  const texts = objects.filter((object): object is TextObject => object.type === 'text')
  const targets = new Map(texts.map((text) => [text.id, { ...text, ...proposals.get(text.id) }]))
  const rows = new Map<number, string[]>()
  const columns = new Map<number, string[]>()
  for (const target of targets.values()) {
    if (target.hidden || !target.panelLabelFor) continue
    const cell = cellByPanel.get(target.panelLabelFor)
    if (!cell) continue
    const row = rows.get(cell.row) ?? []
    row.push(target.id)
    rows.set(cell.row, row)
    const column = columns.get(cell.col) ?? []
    column.push(target.id)
    columns.set(cell.col, column)
  }
  const blockedRows: PanelGridLabelClearancePlan['blockedRows'] = []
  const shifts: PanelGridLabelClearancePlan['shifts'] = []
  const columnShifts: PanelGridLabelClearancePlan['columnShifts'] = []
  const obstaclesFor = (groupCells: readonly ClearanceCell[]) =>
    groupCells.flatMap((cell) => [...(obstaclesByPanel.get(cell.panelId) ?? [])])
  const invalidGroup = (labels: readonly TextObject[], groupCells: readonly ClearanceCell[], obstacles: readonly Rect[]): BlockReason | null => {
    if (labels.some((label) => label.locked || label.layoutPinned || label.groupId)) return 'locked'
    if (labels.some((label) => !valid(label) || !!label.rotationDeg) ||
      groupCells.some((cell) => !valid(cell.bounds) || !obstaclesByPanel.has(cell.panelId)) || obstacles.some((obstacle) => !valid(obstacle))) return 'invalid_geometry'
    return null
  }
  for (const [col, ids] of [...columns].sort(([a], [b]) => a - b)) {
    const labels = ids.map((id) => targets.get(id)!)
    const columnCells = cells.filter((cell) => cell.col === col)
    const obstacles = obstaclesFor(columnCells)
    if (!labels.some((label) => obstacles.some((obstacle) => valid(obstacle) && collides(label, obstacle, 'x', 0)))) continue
    if (invalidGroup(labels, columnCells, obstacles)) continue
    const preceding = cells.filter((cell) => cell.col < col)
    if (preceding.some((cell) => !valid(cell.bounds))) continue
    const edge = Math.max(0, ...preceding.map((cell) => cell.bounds.x + cell.bounds.w))
    const left = displacement(labels, obstacles, 'x', Math.min(...labels.map((label) => label.x - edge)))
    if (left === null) continue
    columnShifts.push({ col, dx: -left })
    for (const label of labels) targets.set(label.id, { ...label, x: round4(label.x - left) })
  }
  for (const [row, ids] of [...rows].sort(([a], [b]) => a - b)) {
    const labels = ids.map((id) => targets.get(id)!)
    const rowCells = cells.filter((cell) => cell.row === row)
    const obstacles = obstaclesFor(rowCells)
    if (!labels.some((label) => obstacles.some((obstacle) => valid(obstacle) && collides(label, obstacle, 'y', 0)))) continue
    const block = (reason: BlockReason) => blockedRows.push({ row, reason })
    const invalid = invalidGroup(labels, rowCells, obstacles)
    if (invalid) { block(invalid); continue }
    const preceding = cells.filter((cell) => cell.row < row)
    if (preceding.some((cell) => !valid(cell.bounds))) { block('invalid_geometry'); continue }
    const floor = Math.max(0, ...preceding.map((cell) => cell.bounds.y + cell.bounds.h))
    const maxUp = Math.min(...labels.map((label) => label.y - floor))
    const up = displacement(labels, obstacles, 'y', maxUp)
    if (up === null) { block('no_space'); continue }
    shifts.push({ row, dy: -up })
    for (const label of labels) targets.set(label.id, { ...label, y: round4(label.y - up) })
  }
  if (blockedRows.length) return { patches: [], blockedRows, shifts: [], columnShifts: [] }
  const patches = texts.flatMap((original): PanelGridLabelPatch[] => {
    const target = targets.get(original.id)!
    if (sameAfterRound4([original.x, original.y], [target.x, target.y]) && original.panelLabelFor === target.panelLabelFor) return []
    return [{ id: target.id, x: target.x, y: target.y, panelLabelFor: target.panelLabelFor }]
  })
  return { patches, blockedRows, shifts, columnShifts }
}
