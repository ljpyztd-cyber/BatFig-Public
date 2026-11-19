/** Pointer cancellation is the tree contract preventing native focus from replacing additive selection. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/Tooltip'
import { literal } from '@/i18n'
import type { Manifest } from '@/lib/api'
import { useAssetStore } from '@/store/assetStore'
import { useDocumentStore } from '@/store/documentStore'
import { useRenderStore } from '@/store/renderStore'
import { useSelectionStore } from '@/store/selectionStore'
import { useUiStore } from '@/store/uiStore'
import { seedExactRender } from '@/test/renderFixtures'
import { emptyProject, type PanelObject, type TextObject } from '@/types/document'
import { ElementTree } from './ElementTree'
import { LayerTree } from './LayerTree'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
Element.prototype.scrollIntoView ??= function scrollIntoView() {}
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

const modifiers = [
  ['Ctrl', { ctrlKey: true }],
  ['Meta', { metaKey: true }],
  ['Shift', { shiftKey: true }],
] as const
const panel: PanelObject = {
  id: 'p', type: 'panel', fileId: 'CtrlTree.pdf', fileKind: 'pdf', script: 'ctrl_tree.py',
  nativeW: 80, nativeH: 60, overrides: [], x: 0, y: 0, w: 80, h: 60,
}
const label = (id: string): TextObject => ({
  id, type: 'text', text: id, fontFamily: 'Arial', sizePt: 10, bold: false,
  color: '#000000', align: 'left', x: 0, y: 0, w: 6, h: 5,
})
const manifest = {
  stem: 'CtrlTree', size_mm: [80, 60],
  elements: [
    { gid: 'figure', role: 'figure', label: 'Figure' },
    { gid: 'axes_0', role: 'axes', label: 'Axes' },
    { gid: 'axes_0.title', role: 'title', label: 'Title' },
    { gid: 'axes_0.xlabel', role: 'axis_label', label: 'X label' },
    { gid: 'axes_0.ylabel', role: 'axis_label', label: 'Y label' },
  ].map((el) => ({ ...el, bbox: [0.1, 0.1, 0.2, 0.2], editable: [{ prop: 'fontsize', type: 'number', value: 10 }] })),
} as unknown as Manifest

let root: Root
let host: HTMLDivElement

beforeEach(async () => {
  localStorage.clear()
  useRenderStore.getState().clear()
  useSelectionStore.getState().clear()
  useUiStore.setState({ elementPanelId: null, selectedGids: [], editingTextId: null, cropTargetId: null })
  await useDocumentStore.getState().switchDocument(emptyProject(), 'ctrl_tree_selection')
  useDocumentStore.getState().commit(literal('fixture'), (d) => { d.objects = [panel, label('a'), label('b'), label('c')] })
  useAssetStore.setState({ byId: { 'CtrlTree.pdf': { id: 'CtrlTree.pdf', mtime: 1 } } } as never)
  seedExactRender(panel, manifest)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function press(selector: string, mods: MouseEventInit = {}) {
  const event = new MouseEvent('pointerdown', { button: 0, bubbles: true, cancelable: true, ...mods })
  await act(async () => host.querySelector(selector)!.dispatchEvent(event))
  return event
}

describe('tree additive selection', () => {
  it.each(modifiers)('%s toggles canvas labels and cancels native pointer focus only for additive selection', async (_name, mods) => {
    await act(async () => root.render(<TooltipProvider><LayerTree /></TooltipProvider>))
    const past = useDocumentStore.getState().past.length
    expect((await press('[data-layer="a"]')).defaultPrevented).toBe(false)
    expect((await press('[data-layer="b"]', mods)).defaultPrevented).toBe(true)
    expect((await press('[data-layer="c"]', mods)).defaultPrevented).toBe(true)
    expect(useSelectionStore.getState().ids).toEqual(['a', 'b', 'c'])
    // A not-currently-focused selected row must remain removed; the browser's focus default is cancelled.
    expect((await press('[data-layer="b"]', mods)).defaultPrevented).toBe(true)
    expect(useSelectionStore.getState().ids).toEqual(['a', 'c'])
    expect(useDocumentStore.getState().past).toHaveLength(past)
  })

  it.each(modifiers)('%s toggles figure text through the element tree and modified Enter', async (_name, mods) => {
    useSelectionStore.getState().set(['p'])
    useUiStore.setState({ elementPanelId: 'p', selectedGids: [] })
    await act(async () => root.render(<TooltipProvider><ElementTree /></TooltipProvider>))
    const past = useDocumentStore.getState().past.length
    expect((await press('[data-el="axes_0.title"]')).defaultPrevented).toBe(false)
    expect((await press('[data-el="axes_0.xlabel"]', mods)).defaultPrevented).toBe(true)
    expect(useUiStore.getState().selectedGids).toEqual(['axes_0.title', 'axes_0.xlabel'])
    expect((await press('[data-el="axes_0.title"]', mods)).defaultPrevented).toBe(true)
    expect(useUiStore.getState().selectedGids).toEqual(['axes_0.xlabel'])
    await act(async () => host.querySelector('[data-el="axes_0.ylabel"]')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...mods }),
    ))
    expect(useUiStore.getState().selectedGids).toEqual(['axes_0.xlabel', 'axes_0.ylabel'])
    expect(useUiStore.getState().elementPanelId).toBe('p')
    expect(useDocumentStore.getState().past).toHaveLength(past)
  })
})
