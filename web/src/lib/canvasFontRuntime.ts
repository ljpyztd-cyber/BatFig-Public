import { create } from 'zustand'
import { jsonFetch } from './api'
import type { ExactTextFamily } from './typography'

export interface CanvasFontFace {
  bold: boolean
  italic: boolean
  postscript_name: string
  sha256: string
  primary: [number, number][]
}

export interface CanvasFontStatus {
  available: boolean
  faces: CanvasFontFace[]
  error?: string
}

/** Local host font facts, never font binaries or a browser font-fallback guess. */
export const useCanvasFontRuntime = create<Record<ExactTextFamily, CanvasFontStatus | null> & {
  failed: boolean
}>(() => ({ Arial: null, 'Times New Roman': null, failed: false }))

let inflight: Promise<void> | null = null
export function refreshCanvasFonts(): Promise<void> {
  if (inflight) return inflight
  inflight = jsonFetch<Partial<Record<ExactTextFamily, CanvasFontStatus>>>('/api/canvas/fonts')
    .then((result) => { useCanvasFontRuntime.setState({
      Arial: result.Arial ?? null, 'Times New Roman': result['Times New Roman'] ?? null, failed: false,
    }) })
    .catch(() => { useCanvasFontRuntime.setState({ Arial: null, 'Times New Roman': null, failed: true }) })
    .finally(() => { inflight = null })
  return inflight
}

export function exactFontFace(family: ExactTextFamily, bold = false, italic = false): CanvasFontFace | undefined {
  const status = useCanvasFontRuntime.getState()[family]
  return status?.available ? status.faces.find((f) => f.bold === bold && f.italic === italic) : undefined
}

export function faceHasGlyph(face: CanvasFontFace, cp: number): boolean {
  return face.primary.some(([start, end]) => cp >= start && cp <= end)
}
