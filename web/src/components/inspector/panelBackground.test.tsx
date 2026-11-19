import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Manifest } from '@/lib/api'
import { useAssetStore } from '@/store/assetStore'
import { useDocumentStore } from '@/store/documentStore'
import { renderKeyOf, useRenderStore } from '@/store/renderStore'
import { seedExactRender } from '@/test/renderFixtures'
import type { PanelObject, PanelOverride } from '@/types/document'
import { PanelBackgroundSection } from './PanelSection'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const panel = (overrides: PanelOverride[] = []): PanelObject => ({
  id: 'p1', type: 'panel', fileId: 'heatmap', fileKind: 'runtime', script: 'heatmap.py',
  x: 0, y: 0, w: 100, h: 70, nativeW: 100, nativeH: 70, overrides,
})
const manifest = (transparent = true, axesTransparent = true): Manifest => ({
  stem: 'heatmap', size_mm: [100, 70], elements: [{
    gid: 'figure', role: 'figure', label: 'Figure', bbox: [0, 0, 1, 1], draggable: false,
    editable: [
      { prop: 'transparent', type: 'bool', value: transparent },
      { prop: 'axes_transparent', type: 'bool', value: axesTransparent },
    ],
  }],
})
let host: HTMLDivElement
let root: Root
const checked = () => host.querySelector('[role="switch"]')?.getAttribute('aria-checked')
const mount = async (p: PanelObject) => {
  await act(async () => root.render(<PanelBackgroundSection objs={[p]} />))
}

beforeEach(() => {
  useAssetStore.setState({ byId: {} })
  useRenderStore.setState({ byKey: {}, latest: {}, recent: {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

it('reads an already transparent exact source and subscribes when that source becomes known', async () => {
  const p = panel()
  const request = vi.spyOn(useRenderStore.getState(), 'render')
  const before = useDocumentStore.getState().past.length
  await mount(p)
  expect(checked()).toBe('false')
  await act(async () => seedExactRender(p, manifest()))
  expect(checked()).toBe('true')
  expect(request).not.toHaveBeenCalled()
  expect(p.overrides).toEqual([])
  expect(useDocumentStore.getState().past).toHaveLength(before)
})

it('uses effective overrides before exact source facts, including explicit false', async () => {
  const p = panel([
    { gid: 'figure', prop: 'transparent', value: true },
    { gid: 'figure', prop: 'transparent', value: false },
  ])
  seedExactRender(p, manifest())
  await mount(p)
  expect(checked()).toBe('false')
})

it('requires both the figure and axes background to be transparent', async () => {
  const p = panel()
  seedExactRender(p, manifest(true, false))
  await mount(p)
  expect(checked()).toBe('false')
})

it('never takes transparency from a stale or different override variant', async () => {
  const p = panel()
  seedExactRender(p, manifest())
  useRenderStore.getState().patch(renderKeyOf(p), { stale: true })
  await mount(p)
  expect(checked()).toBe('false')
  await act(async () => seedExactRender(p, manifest()))
  const changed = panel([{ gid: 'axes_0', prop: 'title', value: 'New title' }])
  await mount(changed)
  expect(checked()).toBe('false')
})
