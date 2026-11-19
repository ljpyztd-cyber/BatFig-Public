import { useEffect, useRef } from 'react'
import { beginElementPreview, cancelElementPreview } from '@/canvas/elementPreview'
import type { ManifestElement } from '@/lib/api'
import { canPreviewStyle } from '@/lib/svgStyle'
import { useDocumentStore } from '@/store/documentStore'
import { previewSession, previewStyle } from '@/store/svgPreviewStore'
import type { PanelObject } from '@/types/document'

/** Color drag preview without document writes, history snapshots, or engine work. */
export function useColorPreview(panel: PanelObject, elements: readonly ManifestElement[]) {
  const ownSession = useRef<number | null>(null)
  const cancel = () => {
    if (ownSession.current != null && previewSession()?.id === ownSession.current) {
      cancelElementPreview()
    }
    ownSession.current = null
  }
  useEffect(() => cancel, [panel.id])

  return (prop: string, value: string | null) => {
    if (value === null) {
      cancel()
      return
    }
    const targets = elements.filter((element) => canPreviewStyle(element.role, prop))
    if (!targets.length) return
    if (ownSession.current == null) {
      // A prior edit may still be displayed only by the preview plane. Do not
      // acquire its rollback ledger: cancelling this draft must not erase it.
      const previous = previewSession()
      if (previous && !previous.settled && previous.pendingCommit?.length) return
      const current = useDocumentStore.getState().doc.objects.find((object) => object.id === panel.id)
      if (current?.type !== 'panel') return
      beginElementPreview(current)
      ownSession.current = previewSession()?.id ?? null
    }
    if (previewSession()?.id !== ownSession.current) return
    for (const target of targets) previewStyle(target.gid, target.role, prop, value)
  }
}
