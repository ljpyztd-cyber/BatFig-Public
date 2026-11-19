import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { literal } from '@/i18n'
import type { Manifest, ManifestElement } from '@/lib/api'
import type { CustomColormap } from '@/lib/customColormap'
import { seedExactRender } from '@/test/renderFixtures'
import { emptyProject, type PanelObject, type PanelOverride } from '@/types/document'
import { setColormaps } from './actions'
import { useDocumentStore } from './documentStore'
import * as scheduler from './renderScheduler'
import { useRenderStore } from './renderStore'

const mesh = (gid: string): ManifestElement => ({
  gid, role: 'collection', label: gid, bbox: [0, 0, 1, 1], editable: [], draggable: false,
})
const a = mesh('axes_0.collections_0')
const b = mesh('axes_1.collections_0')
const colorbar: ManifestElement = {
  ...mesh('axes_2.colorbar'), role: 'colorbar', mappable_gid: a.gid, scale_gids: [b.gid],
  editable: [{ prop: 'cmap', type: 'enum', value: 'viridis', options: ['viridis', 'plasma'] }],
}
const secondBar: ManifestElement = {
  ...mesh('axes_3.colorbar'), role: 'colorbar', mappable_gid: b.gid, scale_gids: [a.gid],
  editable: [{ prop: 'cmap', type: 'enum', value: 'viridis', options: ['viridis', 'plasma'] }],
}
const manifest: Manifest = { stem: 'heatmap', size_mm: [100, 60], elements: [a, b, colorbar, secondBar] }
const diy: CustomColormap = { type: 'custom', colors: ['#2166ac', '#ffffff', '#b2182b'], positions: [0, 0.4, 1] }
const panel = (): PanelObject => useDocumentStore.getState().doc.objects[0] as PanelObject
const overrides = () => panel().overrides
const history = () => useDocumentStore.getState().past

async function seed(patches: PanelOverride[]) {
  await useDocumentStore.getState().switchDocument(emptyProject(), 'colormap-action')
  useDocumentStore.getState().commit(literal('seed'), (d) => {
    d.objects = [{
      id: 'p', type: 'panel', fileId: 'heatmap.pdf', fileKind: 'pdf', name: 'heatmap',
      nativeW: 100, nativeH: 60, x: 0, y: 0, w: 100, h: 60, overrides: patches,
    }]
    d.style = { id: 'style', snapshot: {}, owned: {
      'p@heatmap.pdf': { [a.gid]: { cmap: { value: 'viridis', base: 'magma' } } },
    } }
  })
  useDocumentStore.setState({ past: [], future: [] })
}

beforeEach(() => {
  useRenderStore.getState().clear()
  vi.spyOn(scheduler, 'requestRender').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('heatmap colormap alias writes', () => {
  it('changing a colorbar removes the old heatmap override and releases ownership; undo restores the exact original', async () => {
    const original: PanelOverride[] = [
      { gid: a.gid, prop: 'cmap', value: 'viridis', identity: 'mesh-id' },
      { gid: colorbar.gid, prop: 'cmap', value: 'magma', identity: 'bar-id' },
      { gid: 'axes_0', prop: 'linewidth', value: 1.2 },
    ]
    await seed(original)
    setColormaps('p', [colorbar], manifest, diy)
    expect(overrides().filter((p) => p.prop === 'cmap')).toEqual([
      { gid: colorbar.gid, prop: 'cmap', value: diy, identity: 'bar-id' },
    ])
    expect(useDocumentStore.getState().doc.style?.owned).toBeUndefined()
    expect(history()).toHaveLength(1)
    expect(scheduler.requestRender).toHaveBeenCalledTimes(1)
    useDocumentStore.getState().undo()
    expect(overrides()).toEqual(original)
    expect(useDocumentStore.getState().doc.style?.owned?.['p@heatmap.pdf']?.[a.gid]?.cmap?.value).toBe('viridis')
    useDocumentStore.getState().redo()
    expect(overrides().find((p) => p.prop === 'cmap')?.value).toEqual(diy)
    const project = useDocumentStore.getState().buildProject()
    await useDocumentStore.getState().switchDocument(project, 'colormap-reopened')
    expect(overrides().find((p) => p.prop === 'cmap')?.value).toEqual(diy)
  })

  it('an unchanged map preserves array order, identity, ownership and does not render or push history', async () => {
    await seed([
      { gid: a.gid, prop: 'cmap', value: 'viridis', identity: 'mesh-id' },
      { gid: 'axes_0', prop: 'linewidth', value: 1.2 },
    ])
    const before = useDocumentStore.getState().doc
    setColormaps('p', [a], { ...manifest, elements: [a] }, 'viridis')
    expect(useDocumentStore.getState().doc).toBe(before)
    expect(history()).toHaveLength(0)
    expect(scheduler.requestRender).not.toHaveBeenCalled()
  })

  it('editing from a mappable clears all connected sibling and colorbar overrides', async () => {
    await seed([
      { gid: a.gid, prop: 'cmap', value: 'viridis' },
      { gid: b.gid, prop: 'cmap', value: 'plasma' },
      { gid: colorbar.gid, prop: 'cmap', value: 'magma' },
      { gid: secondBar.gid, prop: 'cmap', value: 'inferno' },
      { gid: 'unrelated_mesh', prop: 'cmap', value: 'coolwarm' },
    ])
    setColormaps('p', [a], manifest, diy)
    expect(overrides()).toEqual([
      { gid: secondBar.gid, prop: 'cmap', value: diy },
      { gid: 'unrelated_mesh', prop: 'cmap', value: 'coolwarm' },
    ])
    const before = useDocumentStore.getState().doc
    vi.mocked(scheduler.requestRender).mockClear()
    setColormaps('p', [b], manifest, structuredClone(diy))
    expect(useDocumentStore.getState().doc).toBe(before)
    expect(history()).toHaveLength(1)
    expect(scheduler.requestRender).not.toHaveBeenCalled()
  })

  it('migrates a narrow legacy mappable writer to the linked colorbar so shared siblings are colored too', async () => {
    await seed([{ gid: a.gid, prop: 'cmap', value: 'viridis' }])
    setColormaps('p', [a, b, colorbar], manifest, 'viridis')
    expect(overrides()).toEqual([{ gid: colorbar.gid, prop: 'cmap', value: 'viridis' }])
    expect(history()).toHaveLength(1)
    expect(scheduler.requestRender).toHaveBeenCalledTimes(1)
  })

  it('removes duplicate and semantic colorbar aliases while retaining the effective writer identity', async () => {
    const bar = { ...colorbar, colorbar_key: 'cbar:axes_0:0' }
    await seed([
      { gid: bar.gid, prop: 'cmap', value: 'inferno' },
      { gid: bar.colorbar_key, prop: 'cmap', value: 'magma' },
      { gid: bar.gid, prop: 'cmap', value: 'plasma', identity: 'bar-id' },
    ])
    setColormaps('p', [bar], { ...manifest, elements: [a, b, bar] }, diy)
    expect(overrides()).toEqual([{ gid: bar.gid, prop: 'cmap', value: diy, identity: 'bar-id' }])
  })

  it('does not write an unsupported linked colorbar property', async () => {
    await seed([{ gid: a.gid, prop: 'cmap', value: 'viridis' }])
    const gated = { ...colorbar, editable: [] }
    setColormaps('p', [a], { ...manifest, elements: [a, gated] }, diy)
    expect(overrides()).toEqual([{ gid: a.gid, prop: 'cmap', value: diy }])
  })

  it('an exact unchanged builtin script map needs no override, history or render', async () => {
    await seed([])
    const builtin = { ...a, editable: [{ prop: 'cmap', type: 'enum' as const, value: 'viridis' }] }
    const exact = { ...manifest, elements: [builtin] }
    seedExactRender(panel(), exact)
    const before = useDocumentStore.getState().doc
    setColormaps('p', [builtin], exact, 'viridis')
    expect(useDocumentStore.getState().doc).toBe(before)
    expect(history()).toHaveLength(0)
    expect(scheduler.requestRender).not.toHaveBeenCalled()
  })

  it('an exact custom script map named viridis still changes to the builtin viridis', async () => {
    await seed([])
    const custom = { ...a, editable: [{ prop: 'cmap', type: 'enum' as const, value: 'viridis',
      cmap_current: { name: 'viridis', custom: true, stops: ['#ff0000', '#0000ff'], discrete: true },
    }] }
    const exact = { ...manifest, elements: [custom] }
    seedExactRender(panel(), exact)
    setColormaps('p', [custom], exact, 'viridis')
    expect(overrides()).toEqual([{ gid: a.gid, prop: 'cmap', value: 'viridis' }])
    expect(history()).toHaveLength(1)
    expect(scheduler.requestRender).toHaveBeenCalledTimes(1)
  })

  it('stale preview facts never suppress a user color change', async () => {
    await seed([])
    const builtin = { ...a, editable: [{ prop: 'cmap', type: 'enum' as const, value: 'viridis' }] }
    const stale = { ...manifest, elements: [builtin] }
    setColormaps('p', [builtin], stale, 'viridis')
    expect(overrides()).toEqual([{ gid: a.gid, prop: 'cmap', value: 'viridis' }])
    expect(history()).toHaveLength(1)
  })
})
