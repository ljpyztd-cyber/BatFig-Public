import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { backendErrorText, jsonFetch } from '@/lib/api'
import { toExportObjects } from '@/lib/exportPayload'
import { currentProjectId } from '@/lib/session'
import { msg } from '@/i18n'
import { useDocumentStore } from '@/store/documentStore'
import { useUiStore } from '@/store/uiStore'
import { mmToWorld } from '@/store/viewportStore'
import type { TextObject } from '@/types/document'
import { effectiveCanvasFamily, type ExactTextFamily } from '@/lib/typography'

interface TextPreview {
  png_base64: string
  width_mm: number
  height_mm: number
  font_family: ExactTextFamily
  image_width_mm?: number
  image_height_mm?: number
  offset_x_mm?: number
  offset_y_mm?: number
}

/** Exact-font pixels come from the same RenderCore as the vector PDF export. */
export function ExactFontTextView({ obj }: { obj: TextObject }) {
  const { t } = useTranslation('inspector')
  const family = effectiveCanvasFamily(obj)
  const editing = useUiStore((s) => s.editingTextId === obj.id)
  const txnOpen = useDocumentStore((s) => s.txn !== null)
  const documentId = useDocumentStore((s) => s.documentId)
  const activeCanvasId = useDocumentStore((s) => s.activeCanvasId)
  const [preview, setPreview] = useState<{ key: string; value: TextPreview } | null>(null)
  const [failure, setFailure] = useState<{ key: string; error: unknown } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  // RenderCore measures height from text and width; do not re-request when that
  // derived height is written back into the document.
  const object = toExportObjects([{ ...obj, hidden: false, x: 0, y: 0, h: 1, rotationDeg: undefined }])[0]
  const payload = JSON.stringify({ object })
  const pj = currentProjectId()
  const key = `${pj}:${documentId}:${activeCanvasId}:${obj.id}:${payload}`

  useEffect(() => {
    const abort = new AbortController()
    let live = true
    void jsonFetch<TextPreview>('/api/canvas/text-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: abort.signal,
    }, pj).then((value) => {
      if (live) setPreview({ key, value })
    }).catch((error: unknown) => {
      if (live && !abort.signal.aborted) setFailure({ key, error })
    })
    return () => { live = false; abort.abort() }
  }, [payload, pj, key])

  const current = preview?.key === key ? preview.value : null
  const error = failure?.key === key ? failure.error : null
  useEffect(() => {
    if (!current || txnOpen || Math.abs(current.height_mm - obj.h) <= 0.05) return
    useDocumentStore.getState().silent((d) => {
      const text = d.objects.find((o) => o.id === obj.id)
      if (text?.type === 'text') text.h = current.height_mm
    })
  }, [current, txnOpen, obj.id, obj.h])

  useEffect(() => {
    if (!editing || !ref.current) return
    ref.current.innerText = obj.text
    ref.current.focus()
    const range = document.createRange()
    range.selectNodeContents(ref.current)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    // Raw source is loaded once per editing session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  const commitText = () => {
    const text = ref.current?.innerText.replace(/\n$/, '')
    useUiStore.getState().setEditingText(null)
    if (text != null && text !== obj.text) {
      useDocumentStore.getState().commit(msg('history.editText', undefined, 'inspector'), (d) => {
        const target = d.objects.find((o) => o.id === obj.id)
        if (target?.type === 'text') target.text = text
      })
    }
  }

  if (editing) return (
    <div data-exact-font-source-editor className="absolute left-0 top-0 w-full bg-surface text-ink-1">
      <div className="text-xs text-ink-3">{t('text.exactFontSourceEditor', { family })}</div>
      <div
        ref={ref}
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        spellCheck={false}
        className="whitespace-pre-wrap outline-none"
        onBlur={commitText}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape' || e.key === 'Enter') {
            e.preventDefault()
            if (e.key === 'Enter' && (e.altKey || e.metaKey || e.ctrlKey)) {
              document.execCommand('insertText', false, '\n')
            } else ref.current?.blur()
          }
        }}
      />
    </div>
  )

  return (
    <div
      data-exact-font-preview={current ? 'ready' : error ? 'error' : 'loading'}
      data-font-family={family}
      className="absolute left-0 top-0 w-full"
      style={{ height: mmToWorld(current?.height_mm ?? obj.h), overflow: 'visible' }}
    >
      {current ? (
        <img
          src={`data:image/png;base64,${current.png_base64}`}
          alt={obj.text}
          draggable={false}
          className="pointer-events-none absolute block"
          style={{
            left: mmToWorld(current.offset_x_mm ?? 0),
            top: mmToWorld(current.offset_y_mm ?? 0),
            width: mmToWorld(current.image_width_mm ?? current.width_mm),
            height: mmToWorld(current.image_height_mm ?? current.height_mm),
          }}
        />
      ) : (
        <div className="text-xs text-danger" style={{ minHeight: mmToWorld(obj.h) }}>
          {error ? t('text.exactFontPreviewFailed', { family, error: backendErrorText(error) }) : t('text.exactFontPreviewLoading', { family })}
        </div>
      )}
    </div>
  )
}
