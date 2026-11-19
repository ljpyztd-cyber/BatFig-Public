/** Editor grid spacing in millimetres; shared by persistence and its control. */
export const DEFAULT_GRID_SIZE = 2
export const MIN_GRID_SIZE = 0.5
export const MAX_GRID_SIZE = 50
export const GRID_SIZE_PRESETS = [1, 2, 5, 10] as const

export function validGridSize(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_GRID_SIZE, Math.max(MIN_GRID_SIZE, value))
    : DEFAULT_GRID_SIZE
}
