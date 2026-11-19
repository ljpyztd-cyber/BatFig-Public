import { describe, expect, it } from 'vitest'
import type { TextObject } from '@/types/document'
import type { Rect } from './geometry'
import type { PanelGridCell } from './panelGrid'
import { planPanelGridLabelClearance } from './panelGridLabelClearance'
import type { PanelGridLabelPatch } from './panelGridLabels'

const letters = (): TextObject[] => [...'abcdefghi'].map((letter, index) => ({
  id: letter, type: 'text', text: letter, panelLabelFor: `panel_${letter}`,
  x: 10 + index % 3 * 30, y: [10, 100, 205][Math.floor(index / 3)], w: 5, h: 6,
  sizePt: 20, fontFamily: 'Arial', bold: false, color: '#000000', align: 'left',
}))
const cells = (): Pick<PanelGridCell, 'panelId' | 'row' | 'col' | 'bounds'>[] => [...'abcdefghi'].map((letter, index) => ({
  panelId: `panel_${letter}`, row: Math.floor(index / 3), col: index % 3,
  bounds: { x: 8 + index % 3 * 30, y: [9, 95, 204][Math.floor(index / 3)], w: 28, h: index < 3 ? 70 : index < 6 ? 105 : 70 },
}))
const obstacles = (extra: Rect[] = []) => new Map<string, readonly Rect[]>(cells().map((cell) => [cell.panelId,
  // The broad text prevents a left move, exercising the vertical fallback.
  cell.panelId === 'panel_g' ? [{ x: -1, y: 208.5, w: 16, h: 5 }, ...extra] : [],
]))
const proposal = (text: TextObject, extra: Partial<PanelGridLabelPatch> = {}): PanelGridLabelPatch => ({
  id: text.id, panelLabelFor: text.panelLabelFor, x: text.x, y: text.y, ...extra,
})

describe('grid label clearance from exact axis text', () => {
  it('moves g/h/i together by only 2.8 mm and keeps all other rows and label styles unchanged', () => {
    const objects = letters()
    const before = structuredClone(objects)
    const plan = planPanelGridLabelClearance(objects, [], cells(), obstacles())
    expect(plan.blockedRows).toEqual([])
    expect(plan.shifts).toEqual([{ row: 2, dy: -2.8 }])
    expect(plan.patches).toEqual(objects.slice(6).map((text) => proposal(text, { y: 202.2 })))
    expect(objects).toEqual(before)
  })

  it('merges base placement and clearance before comparison so repeating apply does not put labels back', () => {
    const objects = letters().map((text, index) => index < 6 ? text : { ...text, y: 202.2 })
    const ordinary = objects.slice(6).map((text) => proposal(text, { y: 205 }))
    expect(planPanelGridLabelClearance(objects, ordinary, cells(), obstacles()).patches).toEqual([])
  })

  it('preserves other base label changes and newly inferred bindings in the final patches', () => {
    const objects = letters()
    objects[6].panelLabelFor = undefined
    const base = [proposal(objects[0], { x: 11 }), proposal(objects[6], { panelLabelFor: 'panel_g' })]
    const plan = planPanelGridLabelClearance(objects, base, cells(), obstacles())
    expect(plan.patches[0]).toEqual(proposal(objects[0], { x: 11 }))
    expect(plan.patches.find((patch) => patch.id === 'g')).toEqual(proposal(objects[6], { y: 202.2, panelLabelFor: 'panel_g' }))
  })

  it('rejects a move into the previous row image envelope and retains the original entire row', () => {
    const blockedCells = cells().map((cell) => cell.row === 1 ? { ...cell, bounds: { ...cell.bounds, h: 109 } } : cell)
    const objects = letters()
    const plan = planPanelGridLabelClearance(objects, objects.slice(6).map((text) => proposal(text, { x: text.x + 1 })), blockedCells, obstacles())
    expect(plan.blockedRows).toEqual([{ row: 2, reason: 'no_space' }])
    expect(plan.patches).toEqual([])
  })

  it('rejects a move above the page and does not silently clamp a single label', () => {
    const bounds = new Map<string, readonly Rect[]>(cells().map((cell) => [cell.panelId,
      cell.panelId === 'panel_a' ? [{ x: -1, y: -1, w: 16, h: 12 }] : [],
    ]))
    const plan = planPanelGridLabelClearance(letters(), [], cells(), bounds)
    expect(plan.blockedRows).toEqual([{ row: 0, reason: 'no_space' }])
    expect(plan.patches).toEqual([])
  })

  it('rechecks upper obstacles reached by a move instead of clearing only the original collision', () => {
    const plan = planPanelGridLabelClearance(letters(), [], cells(), obstacles([{ x: 10, y: 201, w: 5, h: 2 }]))
    expect(plan.blockedRows).toEqual([{ row: 2, reason: 'no_space' }])
    expect(plan.patches).toEqual([])
  })

  it('a locked sibling prevents moving only the overlapping member of a row', () => {
    const objects = letters()
    objects[7].locked = true
    const plan = planPanelGridLabelClearance(objects, [], cells(), obstacles())
    expect(plan.blockedRows).toEqual([{ row: 2, reason: 'locked' }])
    expect(plan.patches).toEqual([])
  })

  it('does not act on horizontal misses and refuses an unknown obstacle surface in an affected row', () => {
    const empty = new Map(cells().map((cell) => [cell.panelId, []]))
    expect(planPanelGridLabelClearance(letters(), [], cells(), empty).patches).toEqual([])
    const partial = obstacles()
    partial.delete('panel_h')
    expect(planPanelGridLabelClearance(letters(), [], cells(), partial).blockedRows)
      .toEqual([{ row: 2, reason: 'invalid_geometry' }])
  })

  const exactScene = () => {
    const objects = letters().map((text, index) => ({ ...text, x: 30 + index % 3 * 60,
      y: [10, 80, 154.2066][Math.floor(index / 3)], w: 4.353, h: 7 }))
    const grid = cells().map((cell) => ({ ...cell, bounds: {
      x: 28.5 + cell.col * 60, y: [9, 79, 153.2066][cell.row], w: 57,
      h: cell.row === 1 ? 71.2066 : 67,
    } }))
    const bounds = new Map<string, readonly Rect[]>(grid.map((cell) => [cell.panelId, []]))
    bounds.set('panel_g', [{ x: 31.274, y: 158.7166, w: 2.65, h: 2.49 }])
    // Actual h geometry: the entire short tick is inside the label. Vertical
    // clearance needs 161.2066 - 155.8587 + .3 = 5.6479 mm, exceeding 4 mm.
    bounds.set('panel_h', [{ x: 93.903, y: 155.8587, w: 2, h: 1.5 }])
    bounds.set('panel_c', [{ x: 153.433, y: 12, w: 2, h: 1.5 }])
    return { objects, grid, bounds }
  }

  it('prefers a minimal shared left shift for all three columns and clears the complete h tick', () => {
    const { objects, grid, bounds } = exactScene()
    const before = structuredClone(objects)
    const plan = planPanelGridLabelClearance(objects, [], grid, bounds)
    expect(plan.blockedRows).toEqual([])
    expect(plan.shifts).toEqual([])
    expect(plan.columnShifts.map((shift) => shift.col)).toEqual([0, 1, 2])
    for (const [col, amount] of [3.379, 0.75, 1.22].entries()) {
      expect(plan.columnShifts[col].dx).toBeCloseTo(-amount, 8)
      for (const text of objects.filter((_, index) => index % 3 === col)) {
        const patch = plan.patches.find((value) => value.id === text.id)!
        expect(patch.x).toBeCloseTo(text.x - amount, 8)
        expect(patch.y).toBe(text.y)
      }
    }
    const movedH = plan.patches.find((patch) => patch.id === 'h')!
    expect(movedH.x + objects[7].w).toBeCloseTo(bounds.get('panel_h')![0].x - 0.3, 8)
    expect(objects).toEqual(before)
  })

  it('repeated ordinary placement plus column clearance is a true no-op', () => {
    const { objects, grid, bounds } = exactScene()
    const first = planPanelGridLabelClearance(objects, [], grid, bounds)
    const after = objects.map((object) => ({ ...object, ...first.patches.find((patch) => patch.id === object.id) }))
    const ordinary = objects.map((object) => proposal(object))
    expect(planPanelGridLabelClearance(after, ordinary, grid, bounds).patches).toEqual([])
  })

  it('rejects an enclosed h tick when neither the previous column nor previous row leaves sufficient room', () => {
    const { objects, grid, bounds } = exactScene()
    // A left move now needs 4.953 mm but the previous complete column leaves 4.5.
    bounds.set('panel_h', [{ x: 89.7, y: 155.8587, w: 5, h: 1.5 }])
    const plan = planPanelGridLabelClearance(objects, [], grid, bounds)
    expect(plan.blockedRows).toEqual([{ row: 2, reason: 'no_space' }])
    expect(plan.patches).toEqual([])
    expect(plan.columnShifts).toEqual([])
  })
})
