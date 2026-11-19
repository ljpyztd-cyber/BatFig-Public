/** Portable color maps stay in document overrides; never depend on a process registry. */
export interface CustomColormap {
  type: 'custom'
  colors: string[]
  positions?: number[]
}

export type ColormapValue = string | CustomColormap

export const MIN_COLOR_STOPS = 3
export const MAX_COLOR_STOPS = 32

export function isCustomColormap(value: unknown): value is CustomColormap {
  if (!value || typeof value !== 'object') return false
  const map = value as CustomColormap
  if (map.type !== 'custom' || !Array.isArray(map.colors)) return false
  if (map.colors.length < MIN_COLOR_STOPS || map.colors.length > MAX_COLOR_STOPS) return false
  if (!Array.from(map.colors).every((color) => typeof color === 'string' && /^#[\da-f]{6}$/i.test(color))) return false
  if (map.positions === undefined) return true
  return Array.isArray(map.positions) && map.positions.length === map.colors.length &&
    Array.from(map.positions).every((p, i, positions) => Number.isFinite(p) && p >= 0 && p <= 1 &&
      (i === 0 ? p === 0 : p > positions[i - 1])) && map.positions.at(-1) === 1
}

export function colormapValue(value: unknown): ColormapValue | null {
  return typeof value === 'string' || isCustomColormap(value) ? value : null
}

export function colorPositions(map: CustomColormap): number[] {
  return map.positions ?? map.colors.map((_, i) => i / (map.colors.length - 1))
}

export function customColormapGradient(map: CustomColormap, dir = 'to right'): string {
  const positions = colorPositions(map)
  return `linear-gradient(${dir}, ${map.colors.map((c, i) => `${c} ${positions[i] * 100}%`).join(', ')})`
}
