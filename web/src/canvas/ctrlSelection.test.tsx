/** Selection gestures use the real object handler; text pixels have separate RenderCore tests. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasTypography, type TypographyAdapter } from '@/components/inspector/typographyAdapter'
import { runUndoRedo } from '@/hooks/useKeyboard'
import { literal } from '@/i18n'
import { useDocumentStore } from '@/store/documentStore'
import { resetGestureCoordinator } from '@/store/gestureCoordinator'
import { useInteractionStore } from '@/store/interactionStore'
import { useSelectionStore } from '@/store/selectionStore'
import { useUiStore } from '@/store/uiStore'
import { mmToWorld, useViewportStore } from '@/store/viewportStore'
import { emptyProject, migrateToProject, type TextObject } from '@/types/document'
import { ObjectView } from './ObjectView'
import { startMarquee } from './interactions'

// Avoid HTTP/font measurement changing geometry: this suite measures selection and document edits.
vi.mock('./TextView', () => ({ TextView: () => null }))

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const modifiers = [
  ['Ctrl', { ctrlKey: true }],
  ['Meta', { metaKey: true }],
  ['Shift', { shiftKey: true }],
] as const
const state = () => useDocumentStore.getState()
const selection = () => useSelectionStore.getState()
const label = (id: string, x: number): TextObject => ({
  id, type: 'text', text: id, fontFamily: 'Arial', sizePt: 10, bold: false,
  color: '#000000', align: 'left', x, y: 10, w: 6, h: 5, panelLabelFor: `panel_${id}`,
})

let host: HTMLDivElement
let root: Root
let adapter: TypographyAdapter

function Harness() {
  const objects = useDocumentStore((s) => s.doc.objects)
  const ids = useSelectionStore((s) => s.ids)
  adapter = useCanvasTypography(objects.filter((o): o is TextObject => o.type === 'text' && ids.includes(o.id)))
  return objects.map((obj) => <ObjectView key={obj.id} obj={obj} />)
}

async function click(id: string, mods: MouseEventInit = {}) {
  await act(async () => {
    host.querySelector(`[data-object-id="${id}"]`)!.dispatchEvent(new MouseEvent('pointerdown', {
      button: 0, clientX: 0, clientY: 0, bubbles: true, cancelable: true, ...mods,
    }))
    window.dispatchEvent(new MouseEvent('pointerup', { button: 0, clientX: 0, clientY: 0, ...mods }))
  })
}

beforeEach(async () => {
  localStorage.clear()
  resetGestureCoordinator()
  useInteractionStore.getState().end()
  useUiStore.setState({ tool: 'select', snapEnabled: false, elementPanelId: null, selectedGids: [], cropTargetId: null, editingTextId: null })
  useViewportStore.setState({ zoom: 1, panX: 0, panY: 0, originX: 0, originY: 0, spaceDown: false })
  selection().clear()
  await state().switchDocument(emptyProject(), 'ctrl_selection')
  state().commit(literal('fixture'), (d) => { d.objects = [label('a', 10), label('b', 30), label('c', 50), label('d', 70)] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(<Harness />))
})

afterEach(async () => {
  await act(async () => {
    window.dispatchEvent(new MouseEvent('pointerup'))
    root.unmount()
  })
  host.remove()
  resetGestureCoordinator()
  useInteractionStore.getState().end()
})

describe('panel-label additive selection', () => {
  it.each(modifiers)('%s adds and removes a/b/c, preserving primary order and document history', async (_name, mods) => {
    const before = state().doc
    const past = state().past.length
    await click('a')
    await click('b', mods)
    await click('c', mods)
    expect(selection().ids).toEqual(['a', 'b', 'c'])
    expect(selection().primary()).toBe('c')
    await click('b', mods)
    expect(selection().ids).toEqual(['a', 'c'])
    await click('a')
    expect(selection().ids).toEqual(['c', 'a'])
    expect(selection().primary()).toBe('a')
    expect(state().doc).toEqual(before)
    expect(state().past).toHaveLength(past)
    expect(state().future).toHaveLength(0)
    expect(state().txn).toBeNull()
  })

  it('Ctrl toggles all group members without dropping the other selected labels', async () => {
    await act(async () => state().commit(literal('group fixture'), (d) => {
      for (const o of d.objects) if (o.id === 'b' || o.id === 'c') o.groupId = 'paired'
    }))
    const past = state().past.length
    await click('a')
    await click('b', { ctrlKey: true })
    expect(selection().ids).toEqual(['a', 'b', 'c'])
    await click('c', { ctrlKey: true })
    expect(selection().ids).toEqual(['a'])
    expect(state().past).toHaveLength(past)
  })

  it('Ctrl adds a canvas label to an existing in-figure selection without exiting figure editing', async () => {
    await act(async () => useUiStore.setState({ elementPanelId: 'panel_a', selectedGids: ['axes_0.title'] }))
    await click('b', { ctrlKey: true })
    expect(useUiStore.getState().elementPanelId).toBe('panel_a')
    expect(useUiStore.getState().selectedGids).toEqual(['axes_0.title'])
    expect(selection().ids).toEqual(['b'])
    await click('c')
    expect(useUiStore.getState().elementPanelId).toBeNull()
  })

  it.each(modifiers)('%s double-click does not open the label text editor', async (_name, mods) => {
    await click('a')
    await click('b', mods)
    await act(async () => host.querySelector('[data-object-id="b"]')!.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, ...mods }),
    ))
    expect(useUiStore.getState().editingTextId).toBeNull()
    expect(selection().ids).toEqual(['a', 'b'])
  })

  it('Ctrl marquee keeps existing labels and adds labels inside the band', async () => {
    await click('a')
    await act(async () => {
      startMarquee({ button: 0, clientX: mmToWorld(29), clientY: mmToWorld(9), ctrlKey: true, shiftKey: false, metaKey: false } as React.PointerEvent)
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: mmToWorld(57), clientY: mmToWorld(16), ctrlKey: true }))
      window.dispatchEvent(new MouseEvent('pointerup', { ctrlKey: true }))
    })
    expect(selection().ids).toEqual(['a', 'b', 'c'])
  })

  it('Ctrl-selected labels share one font edit, undo/redo together, and retain editable text after JSON reopen', async () => {
    await click('a')
    await click('b', { ctrlKey: true })
    await click('c', { ctrlKey: true })
    expect(adapter.count).toBe(3)
    const before = state().doc
    const past = state().past.length
    await act(async () => adapter.writeOnce('fontFamily', 'Times New Roman'))
    const edited = structuredClone(state().doc)
    expect(state().past).toHaveLength(past + 1)
    expect(edited.objects.map((o) => (o as TextObject).fontFamily)).toEqual(['Times New Roman', 'Times New Roman', 'Times New Roman', 'Arial'])
    await act(async () => runUndoRedo(false))
    expect(state().doc).toEqual(before)
    await act(async () => runUndoRedo(true))
    expect(state().doc).toEqual(edited)
    const saved = JSON.parse(JSON.stringify(state().buildProject()))
    const project = migrateToProject(saved)
    expect(project).not.toBeNull()
    await act(async () => state().switchDocument(project!, 'ctrl_selection_reopened'))
    expect(state().doc.objects).toEqual(edited.objects)
    expect(state().doc.objects.map((o) => [(o as TextObject).text, (o as TextObject).panelLabelFor])).toEqual([
      ['a', 'panel_a'], ['b', 'panel_b'], ['c', 'panel_c'], ['d', 'panel_d'],
    ])
    expect(state().past).toHaveLength(0)
  })
})
