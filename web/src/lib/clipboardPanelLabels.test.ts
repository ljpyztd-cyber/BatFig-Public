import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { materializePaste } from './clipboard'
import { CLIPBOARD_FORMAT } from './brand'
import { literal } from '@/i18n'
import { emptyProject, type CanvasObject, type PanelObject, type TextObject } from '@/types/document'
import { useAssetStore } from '@/store/assetStore'
import { useDocumentStore } from '@/store/documentStore'
import { useUiStore } from '@/store/uiStore'

const panel = (): PanelObject => ({
  id: 'panel', type: 'panel', fileId: 'source.pdf', fileKind: 'pdf', overrides: [],
  x: 0, y: 0, w: 80, h: 60, nativeW: 80, nativeH: 60,
})
const label = (): TextObject => ({
  id: 'label', type: 'text', text: '(a)', panelLabelFor: 'panel',
  x: 1, y: 1, w: 8, h: 5, sizePt: 10, bold: true, color: '#000000', align: 'left',
})
const payload = (objects: CanvasObject[]) => ({
  magic: CLIPBOARD_FORMAT, sourceDocId: 'source-document', objects, layoutGroups: [],
})
const state = () => useDocumentStore.getState()
const copiedLabel = () => state().doc.objects.find((o): o is TextObject => o.type === 'text')!
const copiedPanel = () => state().doc.objects.find((o): o is PanelObject => o.type === 'panel')!

beforeEach(async () => {
  await state().switchDocument(emptyProject(), 'paste-label-test')
  useAssetStore.getState().clear()
})
afterEach(() => useUiStore.getState().setStatus(null))

describe('pasted panel label targets', () => {
  it('remaps a label preceding its panel in the payload and keeps undo/redo atomic', () => {
    const source = payload([label(), panel()])
    materializePaste(source, [])
    expect(copiedLabel().panelLabelFor).toBe(copiedPanel().id)
    expect(copiedLabel().panelLabelFor).not.toBe('panel')
    expect((source.objects[0] as TextObject).panelLabelFor).toBe('panel')
    const newTarget = copiedPanel().id
    expect(state().past).toHaveLength(1)
    state().undo()
    expect(state().doc.objects).toHaveLength(0)
    state().redo()
    expect(copiedLabel().panelLabelFor).toBe(newTarget)
  })

  it('clears an isolated label binding even if a source panel with the same id remains in the destination', () => {
    state().commit(literal('existing panel'), (doc) => { doc.objects = [panel()] })
    materializePaste(payload([label()]), [])
    expect(copiedLabel()).not.toHaveProperty('panelLabelFor')
    expect(copiedPanel().id).toBe('panel')
  })

  it('clears the label binding when the associated missing panel is skipped', () => {
    materializePaste(payload([label(), panel()]), [{ fileId: 'source.pdf', name: 'source', count: 1 }])
    expect(state().doc.objects).toHaveLength(1)
    expect(copiedLabel()).not.toHaveProperty('panelLabelFor')
  })

  it('keeps the new binding when the corresponding panel is successfully relinked', () => {
    const target = { id: 'replacement.pdf', name: 'replacement', folder: '.', kind: 'pdf' as const,
      native_w_mm: 90, native_h_mm: 60, mtime: 1 }
    useAssetStore.setState({ byId: { [target.id]: target } })
    materializePaste(payload([label(), panel()]), [{ fileId: 'source.pdf', name: 'source', count: 1, relinkTo: target.id }])
    expect(copiedPanel().fileId).toBe(target.id)
    expect(copiedLabel().panelLabelFor).toBe(copiedPanel().id)
  })

  it('rejects an old binding to a copied non-panel object', () => {
    materializePaste(payload([label(), { ...label(), id: 'panel', panelLabelFor: undefined, text: 'ordinary' }]), [])
    expect(copiedLabel()).not.toHaveProperty('panelLabelFor')
  })
})
