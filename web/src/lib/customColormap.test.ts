import { describe, expect, it } from 'vitest'
import { colorPositions, customColormapGradient, isCustomColormap } from './customColormap'
import { colormapGradient } from '@/components/inspector/controls/colormapStops'

describe('portable DIY colormap', () => {
  const colors = ['#0000ff', '#ffffff', '#ff0000']
  it('keeps nonuniform stops in previews even while old backend facts remain', () => {
    const map = { type: 'custom' as const, colors, positions: [0, 0.2, 1] }
    expect(isCustomColormap(map)).toBe(true)
    expect(colormapGradient(map, { name: 'batfig_custom', custom: true, stops: ['#000000', '#ffffff'], discrete: false }))
      .toBe('linear-gradient(to right, #0000ff 0%, #ffffff 20%, #ff0000 100%)')
    expect(customColormapGradient(map, 'to top')).toContain('to top')
  })
  it('defaults unspecified positions to evenly spaced stops', () => {
    expect(colorPositions({ type: 'custom', colors })).toEqual([0, 0.5, 1])
  })
  it.each([
    { type: 'custom', colors: colors.slice(0, 2) },
    { type: 'custom', colors, positions: [0, 0, 1] },
    { type: 'custom', colors, positions: [0, NaN, 1] },
    { type: 'custom', colors, positions: [0, 0.5, 0.9] },
    { type: 'custom', colors: ['#000000', 'red', '#ffffff'] },
    { type: 'custom', colors: Array(33).fill('#ffffff') },
    { type: 'custom', colors: [['#000000'], '#ffffff', '#ff0000'] },
    { type: 'custom', colors: Array(3) },
    { type: 'custom', colors, positions: [0, , 1] },
  ])('rejects invalid color definitions: %j', (map) => {
    expect(isCustomColormap(map)).toBe(false)
  })
})
