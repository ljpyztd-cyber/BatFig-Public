import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ElementInspector } from '@/components/inspector/ElementInspector'
import { TooltipProvider } from '@/components/ui/Tooltip'
import { literal } from '@/i18n'
import type { Manifest, ManifestElement } from '@/lib/api'
import { alignEntries } from '@/lib/elementGeom'
import { seedExactRender } from '@/test/renderFixtures'
import { emptyProject, type PanelObject } from '@/types/document'
import { alignSelectedPanelElements } from './alignAction'
import { useDocumentStore } from './documentStore'
import { useRenderStore } from './renderStore'
import { useSelectionStore } from './selectionStore'
import { useUiStore } from './uiStore'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const axes = (gid: string, pos: [number, number, number, number], colorbar = false): ManifestElement => ({
  gid, role: 'axes', label: gid,
  bbox: [pos[0], 1 - pos[1] - pos[3], pos[2], pos[3]],
  draggable: false, resizable: true, is_colorbar: colorbar,
  editable: [{ prop: 'position', type: 'rect', value: pos }],
})
const label = (gid: string, role = 'axis_label'): ManifestElement => ({
  gid, role, label: 'colorbar label', bbox: [0, 0.1, 0.01, 0.2],
  draggable: true, anchor: [0, 0.1], drag_prop: 'pos_frac', editable: [],
})
const elements: ManifestElement[] = [
  axes('plot_a', [0.1, 0.2, 0.3, 0.4]),
  axes('plot_b', [0.6, 0.5, 0.2, 0.3]),
  // The bars deliberately extend beyond the plotting rectangles and have
  // different aspect ratios, so including either changes the alignment.
  axes('vertical_scale', [0.01, 0.05, 0.02, 0.9], true),
  axes('horizontal_scale', [0.4, 0.01, 0.5, 0.02], true),
  { gid: 'color_scale', role: 'colorbar', label: 'color scale', bbox: [0.01, 0.05, 0.02, 0.9],
    draggable: false, resizable: true, geom_gid: 'vertical_scale', editable: [] },
  { gid: 'heatmap', role: 'image', label: 'heatmap', bbox: [0.1, 0.4, 0.3, 0.4],
    draggable: false, resizable: true, geom_gid: 'plot_a', editable: [] },
  label('vertical_scale.ylabel'),
  label('vertical_scale.title', 'title'),
  label('horizontal_scale.xticklabel_0', 'tick_label'),
  // A suggestive name without an identified colorbar owner is not evidence.
  label('unknown_scale.ylabel'),
]
const manifest: Manifest = { stem: 'colorbar-alignment', size_mm: [100, 80], elements }
const initialPanel: PanelObject = {
  id: 'panel', type: 'panel', name: 'heatmap panel', fileId: 'heatmap.pdf', fileKind: 'pdf',
  nativeW: 100, nativeH: 80, x: 10, y: 10, w: 100, h: 80, overrides: [],
}
const livePanel = () => useDocumentStore.getState().doc.objects[0] as PanelObject
const selected = ['plot_a', 'plot_b', 'vertical_scale', 'horizontal_scale', 'color_scale',
  'vertical_scale.ylabel', 'vertical_scale.title', 'horizontal_scale.xticklabel_0']
let root: Root | undefined
let host: HTMLDivElement | undefined

beforeEach(async () => {
  useRenderStore.getState().clear()
  await useDocumentStore.getState().switchDocument(emptyProject(), 'colorbar-alignment')
  useDocumentStore.getState().commit(literal('setup'), (doc) => { doc.objects = [structuredClone(initialPanel)] })
  useDocumentStore.setState({ past: [], future: [] })
  useSelectionStore.getState().set(['panel'])
  useUiStore.setState({ elementPanelId: 'panel', selectedGids: selected })
  seedExactRender(livePanel(), manifest)
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
  host = undefined
  vi.restoreAllMocks()
})

describe('independent color scales in figure arrangement', () => {
  it.each([
    ['left', 'plot_b', [0.1, 0.5, 0.2, 0.3]],
    ['right', 'plot_a', [0.5, 0.2, 0.3, 0.4]],
    ['top', 'plot_a', [0.1, 0.4, 0.3, 0.4]],
    ['bottom', 'plot_b', [0.6, 0.2, 0.2, 0.3]],
    ['samew', 'plot_a', [0.1, 0.2, 0.2, 0.4]],
    ['sameh', 'plot_a', [0.1, 0.3, 0.3, 0.3]],
  ] as const)('%s ignores both colorbar boundaries and a last-selected colorbar', (mode, gid, value) => {
    const before = structuredClone(livePanel().overrides)
    const result = alignSelectedPanelElements('panel', mode)
    expect(result).toEqual({ ok: true, patches: 1, moves: 0 })
    expect(livePanel().overrides).toEqual([{ gid, prop: 'position', value: [...value] }])
    expect(useDocumentStore.getState().past).toHaveLength(1)
    useDocumentStore.getState().undo()
    expect(livePanel().overrides).toEqual(before)
    useDocumentStore.getState().redo()
    expect(livePanel().overrides).toEqual([{ gid, prop: 'position', value: [...value] }])
  })

  it('a plot plus its colorbars does not become a multiple-plot alignment', () => {
    useUiStore.setState({ selectedGids: ['plot_a', 'vertical_scale', 'color_scale'] })
    expect(alignSelectedPanelElements('panel', 'left')).toEqual({ ok: false, reason: 'too-few' })
    expect(livePanel().overrides).toEqual([])
    expect(useDocumentStore.getState().past).toHaveLength(0)
  })

  it('keeps the heatmap proxy eligible while colorbar geometry remains available for direct manipulation', () => {
    const gids = ['heatmap', 'plot_b', 'color_scale', 'horizontal_scale']
    expect(alignEntries(livePanel(), manifest, gids, { excludeColorbars: true }).map((item) => item.key))
      .toEqual(['plot_a', 'plot_b'])
    const direct = alignEntries(livePanel(), manifest, gids)
    expect(direct.map((item) => item.key)).toEqual(['plot_a', 'plot_b', 'vertical_scale', 'horizontal_scale'])
    expect(direct[2].write([0.1, 0.2, 0.03, 0.6]))
      .toEqual({ gid: 'vertical_scale', prop: 'position', value: [0.1, 0.2, 0.03, 0.6] })
  })

  it('excludes only descendants of confirmed colorbar axes, leaving independent labels editable', () => {
    const gids = ['vertical_scale.ylabel', 'vertical_scale.title', 'horizontal_scale.xticklabel_0', 'unknown_scale.ylabel']
    expect(alignEntries(livePanel(), manifest, gids, { excludeColorbars: true }).map((item) => item.key))
      .toEqual(['unknown_scale.ylabel'])
    expect(alignEntries(livePanel(), manifest, gids).map((item) => item.key)).toEqual(gids)
  })

  it('the inspector lists exactly the same plotting targets as the alignment action', async () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(<TooltipProvider><ElementInspector panel={livePanel()} /></TooltipProvider>))
    const targets = [...host.querySelectorAll('[data-element-align-gid]')].map((node) => node.getAttribute('data-element-align-gid'))
    expect(targets).toEqual(['plot_a', 'plot_b'])
    expect(host.textContent).toContain('已选 2 个元素')
  })
})
