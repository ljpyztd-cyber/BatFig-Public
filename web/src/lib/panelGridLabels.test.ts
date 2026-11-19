import { describe, expect, it } from 'vitest'
import type { CanvasObject, PanelObject, TextObject } from '@/types/document'
import { planPanelGridLabels } from './panelGridLabels'

const panel = (id: string, patch: Partial<PanelObject> = {}): PanelObject => ({
  id, type: 'panel', fileId: `${id}.pdf`, fileKind: 'pdf', nativeW: 40, nativeH: 30,
  x: 10, y: 20, w: 40, h: 30, overrides: [], ...patch,
})
const label = (id: string, patch: Partial<TextObject> = {}): TextObject => ({
  id, type: 'text', text: 'a', sizePt: 14, bold: true, fontFamily: 'Arial',
  color: '#000000', align: 'left', x: 8, y: 18, w: 5, h: 6, ...patch,
})
const moved = { id: 'p', x: 100, y: 60, w: 80, h: 60 }
const cells = [{ panelId: 'p', bounds: { x: 90, y: 50, w: 100, h: 80 } }]

describe('panel grid labels', () => {
  it('places a bound label at the common cell inset, preserving text, dimensions and type style', () => {
    const objects: CanvasObject[] = [panel('p'), label('l', { text: 'custom', panelLabelFor: 'p', x: 12, y: 22 })]
    const original = structuredClone(objects)
    expect(planPanelGridLabels(objects, [moved], cells)).toEqual([
      { id: 'l', x: 91.5, y: 51, panelLabelFor: 'p' },
    ])
    expect(objects).toEqual(original)
  })

  it.each(['a', '(A)'])('conservatively binds a unique historical %s near the panel top-left', (text) => {
    expect(planPanelGridLabels([panel('p'), label('l', { text })], [moved], cells)).toEqual([
      { id: 'l', x: 91.5, y: 51, panelLabelFor: 'p' },
    ])
  })

  it('resets differing old offsets to the same grid inset, without shrinking oversized labels', () => {
    const largeOffset = label('l', { panelLabelFor: 'p', x: -100, y: 100 })
    expect(planPanelGridLabels([panel('p'), largeOffset], [moved], cells)).toEqual([
      { id: 'l', x: 91.5, y: 51, panelLabelFor: 'p' },
    ])
    expect(planPanelGridLabels([panel('p'), { ...largeOffset, w: 99 }], [moved], cells)).toEqual([])
    expect(planPanelGridLabels([panel('p'), largeOffset], [moved])).toEqual([
      { id: 'l', x: 100, y: 114, panelLabelFor: 'p' },
    ])
  })

  it('does not infer ordinary annotations, distant letters or rotated letters', () => {
    for (const candidate of [
      label('l', { text: 'High' }), label('l', { text: 'a1' }),
      label('l', { text: '10' }), label('l', { x: -1 }),
      label('l', { x: 19 }), label('l', { rotationDeg: 10 }),
    ]) expect(planPanelGridLabels([panel('p'), candidate], [moved], cells)).toEqual([])
  })

  it('does not assign an ambiguous label or move another candidate for either competing panel', () => {
    const objects = [panel('p'), panel('q', { x: 20 }), label('ambiguous', { x: 15 }), label('candidate', { x: 8 })]
    expect(planPanelGridLabels(objects, [moved], cells)).toEqual([])
    expect(planPanelGridLabels([panel('p'), label('l'), label('l2', { text: '(b)' })], [moved], cells)).toEqual([])
  })

  it('gives explicit associations priority and never rebinds a stale one', () => {
    const objects = [panel('p'), label('bound', { panelLabelFor: 'p' }), label('nearby', { text: 'b' })]
    expect(planPanelGridLabels(objects, [moved], cells).map((patch) => patch.id)).toEqual(['bound'])
    expect(planPanelGridLabels([panel('p'), label('stale', { panelLabelFor: 'deleted' })], [moved], cells)).toEqual([])
  })

  it('respects hidden/locked labels and panels, as well as missing geometry or cell data', () => {
    for (const patch of [{ hidden: true }, { locked: true }]) {
      expect(planPanelGridLabels([panel('p'), label('l', patch)], [moved], cells)).toEqual([])
      expect(planPanelGridLabels([panel('p', patch), label('l', { panelLabelFor: 'p' })], [moved], cells)).toEqual([])
    }
    expect(planPanelGridLabels([panel('p'), label('l')], [])).toEqual([])
    expect(planPanelGridLabels([panel('p'), label('l')], [moved], [])).toEqual([])
    expect(planPanelGridLabels([panel('p'), label('l', { w: 101 })], [moved], cells)).toEqual([])
  })

  it('does not detach grouped or pinned labels, and counts fixed letters as ambiguity', () => {
    for (const patch of [{ groupId: 'letters' }, { layoutPinned: true }, { locked: true }]) {
      expect(planPanelGridLabels([panel('p'), label('l', { panelLabelFor: 'p', ...patch })], [moved], cells)).toEqual([])
      expect(planPanelGridLabels([panel('p'), label('l', patch), label('other', { text: 'b' })], [moved], cells)).toEqual([])
    }
  })

  it('can attach an unchanged historical label when the layout has no geometry patch', () => {
    const sameCell = [{ panelId: 'p', bounds: { x: 0, y: 10, w: 60, h: 50 } }]
    expect(planPanelGridLabels([panel('p'), label('l')], [], sameCell)).toEqual([
      { id: 'l', x: 1.5, y: 11, panelLabelFor: 'p' },
    ])
  })

  it('is idempotent after a layout commit and never changes an unrelated annotation', () => {
    const objects: CanvasObject[] = [panel('p'), label('l'), label('annotation', { text: 'test' })]
    const patches = [...[moved], ...planPanelGridLabels(objects, [moved], cells)]
    const committed = objects.map((object) => ({ ...object, ...patches.find((patch) => patch.id === object.id) })) as CanvasObject[]
    expect(planPanelGridLabels(committed, [moved], cells)).toEqual([])
    expect(committed[2]).toEqual(objects[2])
  })
})
