import type { Manifest } from './api'
import { isElementHidden, panelFullRect } from './elementGeom'
import { boundsOf, rectOf, type Rect } from './geometry'
import { panelRotation, rotateVec, type CanvasObject, type PanelObject } from '@/types/document'

/** Visible plotting-area bounds in page mm. A colorbar is not a plotting area.
 * Callers must supply the exact manifest for this panel variant (ADR 0017).
 * Twin axes naturally share a rectangle; multiple subplots use their union.
 */
export function panelAxesBounds(panel: PanelObject, manifest: Manifest): Rect | null {
  const full = panelFullRect(panel)
  const cx = panel.x + panel.w / 2
  const cy = panel.y + panel.h / 2
  const boxes: Rect[] = []
  for (const el of manifest.elements) {
    if ((el.role !== 'axes' && el.role !== 'axes3d') || el.is_colorbar || isElementHidden(el)) continue
    const [x, y, w, h] = el.bbox
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue
    const corners = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([fx, fy]) => {
      const dx = (full.x + fx * full.w - cx) * (panel.flipH ? -1 : 1)
      const dy = (full.y + fy * full.h - cy) * (panel.flipV ? -1 : 1)
      const [rx, ry] = rotateVec(dx, dy, panelRotation(panel))
      return [cx + rx, cy + ry]
    })
    // The crop window stays axis-aligned even when a panel is rotated.
    const left = Math.max(panel.x, Math.min(...corners.map((p) => p[0])))
    const top = Math.max(panel.y, Math.min(...corners.map((p) => p[1])))
    const right = Math.min(panel.x + panel.w, Math.max(...corners.map((p) => p[0])))
    const bottom = Math.min(panel.y + panel.h, Math.max(...corners.map((p) => p[1])))
    if (right > left && bottom > top) boxes.push({ x: left, y: top, w: right - left, h: bottom - top })
  }
  return rectUnion(boxes)
}

export function rectUnion(boxes: Rect[]): Rect | null {
  return boundsOf(boxes)
}

export interface CanvasAlignmentGeometry {
  boxes: Map<string, Rect>
  pending: boolean
  fallbackCount: number
}

/** No partial alignment: any unknown panel geometry blocks the whole action. */
export function canvasAlignmentGeometry(
  objects: CanvasObject[],
  basis: 'axes' | 'image',
  exactManifest: (panel: PanelObject) => Manifest | null,
  layoutOnly: (panel: PanelObject) => boolean,
): CanvasAlignmentGeometry {
  const boxes = new Map<string, Rect>()
  let pending = false
  let fallbackCount = 0
  for (const object of objects) {
    let box = rectOf(object)
    if (basis === 'axes' && object.type === 'panel') {
      const manifest = exactManifest(object)
      if (!manifest && !layoutOnly(object)) {
        pending = true
        continue
      }
      const axes = manifest ? panelAxesBounds(object, manifest) : null
      if (axes) box = axes
      else fallbackCount++
    } else if (basis === 'axes') fallbackCount++
    boxes.set(object.id, box)
  }
  return { boxes, pending, fallbackCount }
}
