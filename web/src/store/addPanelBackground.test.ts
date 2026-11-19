import { beforeEach, describe, expect, it } from 'vitest'
import type { PanelCapability, PanelInfo } from '@/lib/api'
import { emptyProject, type PanelObject } from '@/types/document'
import { addPanel, replacePanelAsset } from './actions'
import { useDocumentStore } from './documentStore'

const info = (capability?: PanelCapability): PanelInfo => ({
  id: 'heatmap.pdf', name: 'heatmap', folder: '.', kind: 'pdf',
  native_w_mm: 100, native_h_mm: 70, mtime: 1, script: 'heatmap.py', capability,
})

describe('replacePanelAsset background defaults', () => {
  const originalPanel = () => addPanel({ ...info(), id: 'original.pdf' })
  const livePanel = (): PanelObject => useDocumentStore.getState().doc.objects[0] as PanelObject

  it('defaults an editable replacement to transparent and undoes the whole replacement once', async () => {
    const original = originalPanel()
    const before = useDocumentStore.getState().past.length
    expect(await replacePanelAsset(original.id, info(capability('editable', 'registered_source')))).toBe(true)
    expect(livePanel().overrides).toEqual([
      { gid: 'figure', prop: 'transparent', value: true },
      { gid: 'figure', prop: 'axes_transparent', value: true },
    ])
    expect(livePanel()).toMatchObject({ id: original.id, x: original.x, y: original.y, w: original.w, h: original.h })
    expect(useDocumentStore.getState().past).toHaveLength(before + 1)
    useDocumentStore.getState().undo()
    expect(livePanel()).toEqual(original)
  })

  it.each([
    ['source missing', info(capability('source_missing', 'registered_script_missing'))],
    ['layout only', info(capability('layout_only', 'no_source_candidate'))],
    ['unknown', info()],
    ['no script', { ...info(capability('editable', 'registered_source')), script: undefined }],
  ] as const)('keeps original appearance for a %s replacement', async (_name, replacement) => {
    const original = originalPanel()
    await replacePanelAsset(original.id, replacement)
    expect(livePanel().overrides).toEqual([])
  })

  it('preserves a replacement source’s explicit background baseline without mutating it', async () => {
    const original = originalPanel()
    const baseline = [{ gid: 'figure', prop: 'transparent', value: false }]
    await replacePanelAsset(original.id, {
      ...info(capability('editable', 'registered_source')), baked_overrides: baseline,
    })
    expect(livePanel().overrides).toEqual([
      ...baseline, { gid: 'figure', prop: 'axes_transparent', value: true },
    ])
    expect(baseline).toEqual([{ gid: 'figure', prop: 'transparent', value: false }])
    expect(livePanel().overrides[0]).not.toBe(baseline[0])
  })
})
const capability = (status: PanelCapability['status'], reason_code: PanelCapability['reason_code']): PanelCapability => ({
  status, reason_code, script: 'heatmap.py', candidates: [], can_probe: false, can_manual_link: true,
})

beforeEach(async () => {
  await useDocumentStore.getState().switchDocument(emptyProject(), 'new-panel-background')
})

describe('addPanel background defaults follow backend editability', () => {
  it('adds transparent backgrounds for a confirmed editable script and keeps the action undoable', () => {
    const added = addPanel(info(capability('editable', 'registered_source')))
    expect(added.overrides).toEqual([
      { gid: 'figure', prop: 'transparent', value: true },
      { gid: 'figure', prop: 'axes_transparent', value: true },
    ])
    expect(useDocumentStore.getState().doc.objects).toHaveLength(1)
    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().doc.objects).toHaveLength(0)
  })

  it.each([
    ['source missing', capability('source_missing', 'registered_script_missing')],
    ['layout only', capability('layout_only', 'no_source_candidate')],
    ['unknown', undefined],
  ] as const)('preserves original %s panels even when a script path was registered', (_name, state) => {
    const original = [{ gid: 'figure', prop: 'transparent', value: false }]
    const added = addPanel({ ...info(state), baked_overrides: original })
    expect(added.overrides).toEqual(original)
    expect(added.overrides).not.toBe(original)
    expect(original).toEqual([{ gid: 'figure', prop: 'transparent', value: false }])
  })

  it('requires an executable script path as well as an editable capability', () => {
    const added = addPanel({ ...info(capability('editable', 'registered_source')), script: undefined })
    expect(added.overrides).toEqual([])
  })
})
