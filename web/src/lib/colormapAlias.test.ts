import { describe, expect, it } from 'vitest'
import type { Manifest, ManifestElement } from './api'
import { colormapAliasGids } from './colormapAlias'

const element = (gid: string, rest: Partial<ManifestElement> = {}): ManifestElement => ({
  gid, role: 'collection', label: gid, bbox: [0, 0, 1, 1], draggable: false, editable: [], ...rest,
})

describe('colormap relation closure', () => {
  it('starting from any linked heatmap reaches sibling heatmaps and every bar, independent of manifest order', () => {
    const a = element('a'), b = element('b'), c = element('c')
    const ab = element('ab', { role: 'colorbar', mappable_gid: 'a', scale_gids: ['b'], colorbar_key: 'semantic:ab' })
    const bc = element('bc', { role: 'colorbar', mappable_gid: 'b', scale_gids: ['c'] })
    const unrelated = element('other', { role: 'colorbar', mappable_gid: 'x' })
    const manifest: Manifest = { stem: 'heatmap', size_mm: [100, 60], elements: [bc, unrelated, ab, a, b, c] }
    for (const start of [a, b, c, ab, bc]) {
      expect(new Set(colormapAliasGids(manifest, start))).toEqual(new Set(['a', 'b', 'c', 'ab', 'bc', 'semantic:ab']))
    }
  })
})
