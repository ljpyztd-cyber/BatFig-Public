/** Shared color samples for single colors and user-built heatmap gradients. */
export const COMMON_COLORS = [
  '#000000', '#666666', '#999999', '#ffffff', '#d62728', '#ff7f0e',
  '#edc948', '#2ca02c', '#17becf', '#1f77b4', '#9467bd', '#e377c2',
  '#8c564b', '#bcbd22', '#003f5c', '#7a5195', '#ef5675', '#ffa600',
] as const

export const COLOR_PALETTES = [
  {
    id: 'classic', nameKey: 'colorPalettes.classic', kind: 'categorical',
    colors: ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b'],
  },
  {
    id: 'contrast', nameKey: 'colorPalettes.contrast', kind: 'categorical',
    colors: ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#56b4e9', '#d55e00'],
  },
  {
    id: 'muted', nameKey: 'colorPalettes.muted', kind: 'categorical',
    colors: ['#4878a8', '#ee854a', '#6acc64', '#d65f5f', '#956cb4', '#8c613c'],
  },
  {
    id: 'blueWhiteRed', nameKey: 'colorPalettes.blueWhiteRed', kind: 'diverging',
    colors: ['#2166ac', '#67a9cf', '#f7f7f7', '#ef8a62', '#b2182b'],
  },
  {
    id: 'blueGold', nameKey: 'colorPalettes.blueGold', kind: 'diverging',
    colors: ['#0b3c5d', '#328cc1', '#d9d9d9', '#e9c46a', '#d98e04'],
  },
  {
    id: 'purpleGreen', nameKey: 'colorPalettes.purpleGreen', kind: 'diverging',
    colors: ['#762a83', '#af8dc3', '#f7f7f7', '#7fbf7b', '#1b7837'],
  },
] as const
