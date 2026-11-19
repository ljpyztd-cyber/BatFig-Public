import { describe, expect, it } from 'vitest'
import { newPanelOverrides } from './panelBackground'
import { emptyDocument, emptyProject } from '@/types/document'

describe('new canvas and editable figure backgrounds', () => {
  it('new canvases explicitly use white opaque paper', () => {
    expect(emptyDocument().page).toMatchObject({ bg: '#ffffff', transparent: false })
    expect(emptyProject().canvases[0].page).toMatchObject({ bg: '#ffffff', transparent: false })
  })
  it('only editable new figures get transparent outer and axes backgrounds', () => {
    expect(newPanelOverrides(true)).toEqual([
      { gid: 'figure', prop: 'transparent', value: true },
      { gid: 'figure', prop: 'axes_transparent', value: true },
    ])
    // Unknown, static and missing-source assets must keep the original without forcing a render.
    expect(newPanelOverrides(false)).toEqual([])
  })
  it('preserves explicit source overrides and does not mutate them', () => {
    const baseline = [{ gid: 'figure', prop: 'transparent', value: false }]
    const next = newPanelOverrides(true, baseline)
    expect(next[0]).toEqual(baseline[0])
    expect(next).toHaveLength(2)
    expect(baseline).toHaveLength(1)
    expect(next[0]).not.toBe(baseline[0])
  })
})
