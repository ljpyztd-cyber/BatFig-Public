import { docToCanvas, type CanvasData, type FigureDocument, type ProjectDocument } from '@/types/document'

export interface CheckpointSource {
  doc: FigureDocument
  canvases: CanvasData[]
  activeCanvasId: string
  projectMeta: { name: string }
}

// Registry-derived metadata is persisted for recovery, but is not a user's edit.
// Keep the same four fields as panelSourceSync; geometry and overrides stay here.
function canvasContent(canvas: CanvasData): unknown {
  return {
    ...canvas,
    objects: canvas.objects.map((object) => {
      if (object.type !== 'panel') return object
      const copy: Partial<typeof object> = { ...object }
      delete copy.script
      delete copy.cost
      delete copy.fileKind
      delete copy.pxW
      return copy
    }),
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]))
  }
  return value
}

export function projectContentKey(project: ProjectDocument): string {
  return JSON.stringify(canonical({ name: project.project.name, canvases: project.canvases.map(canvasContent) }))
}

export function currentContentKey(state: CheckpointSource): string {
  return JSON.stringify(canonical({
    name: state.projectMeta.name,
    canvases: state.canvases.map((canvas) => canvasContent(
      canvas.id === state.activeCanvasId ? docToCanvas(state.doc, canvas.id) : canvas,
    )),
  }))
}

export function canvasContentKey(state: CheckpointSource, id: string): string | null {
  const canvas = state.canvases.find((item) => item.id === id)
  if (!canvas) return null
  return JSON.stringify(canonical(canvasContent(id === state.activeCanvasId ? docToCanvas(state.doc, id) : canvas)))
}

export function savedCanvasContentKey(checkpoint: string | null, id: string): string | null {
  if (!checkpoint) return null
  const content = JSON.parse(checkpoint) as { canvases: CanvasData[] }
  const canvas = content.canvases.find((item) => item.id === id)
  return canvas ? JSON.stringify(canvas) : null
}
