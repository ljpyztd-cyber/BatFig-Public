import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasFontRuntime } from './canvasFontRuntime'
import { textDiagnostics } from './glyphPlan'
import { loadProfile } from './profile'
import { runSpec, type PreflightSpec } from './preflight'
import { addSubLabels, addText } from '@/store/actions'
import { useDocumentStore } from '@/store/documentStore'
import { emptyProject, migrateToProject, type PanelObject, type TextObject } from '@/types/document'
import { toExportObjects } from './exportPayload'
import { collectPanelAnnotations } from './writeBackAnnotations'
import { startDraw } from '@/canvas/interactions'
import { useUiStore } from '@/store/uiStore'
import { mmToWorld, useViewportStore } from '@/store/viewportStore'
import { buildPreset, insertSymbol, PRESET_IDS } from './presets'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { literal } from '@/i18n'

const panel: PanelObject = {
  id: 'p', type: 'panel', fileId: 'curve.pdf', fileKind: 'pdf', nativeW: 40, nativeH: 30,
  x: 0, y: 0, w: 40, h: 30, overrides: [],
}

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
  useCanvasFontRuntime.setState({ Arial: null, 'Times New Roman': null, failed: false })
  localStorage.clear()
  useUiStore.setState({ tool: 'select', snapEnabled: false, elementPanelId: null, editingTextId: null })
  useViewportStore.setState({ zoom: 1, panX: 0, panY: 0, originX: 0, originY: 0 })
  await useDocumentStore.getState().switchDocument(emptyProject(), 'arial_roundtrip')
})

describe('Arial canvas contract', () => {
  it.each(['Arial', 'Times New Roman'] as const)('selected %s persists through undo, reopen, export and annotation writeback', async (family) => {
    const text = addText({ text: 'α H_{2}O / mAh g^{-1}' })
    useDocumentStore.getState().silent((d) => { d.objects.push(panel) })
    addSubLabels()
    const before = useDocumentStore.getState().doc.objects.filter((o) => o.type === 'text')
    expect(before).toHaveLength(2)
    expect(before.every((o) => o.fontFamily === 'Arial' && o.sizePt === 20 && !o.bold && !o.italic)).toBe(true)
    useDocumentStore.getState().commit(literal('font'), (d) => {
      for (const obj of d.objects) if (obj.type === 'text') obj.fontFamily = family
    })
    if (family !== 'Arial') {
      useDocumentStore.getState().undo()
      expect(useDocumentStore.getState().doc.objects.filter((o) => o.type === 'text').every((o) => o.fontFamily === 'Arial')).toBe(true)
      useDocumentStore.getState().redo()
    }
    const saved = JSON.parse(JSON.stringify(useDocumentStore.getState().buildProject()))
    await useDocumentStore.getState().switchDocument(migrateToProject(saved)!, 'exact_font_reopened')
    const reopened = useDocumentStore.getState().doc.objects.find((o) => o.id === text.id) as TextObject
    expect(useDocumentStore.getState().doc.objects.filter((o) => o.type === 'text').every((o) => o.fontFamily === family)).toBe(true)
    expect(toExportObjects([reopened])[0]).toMatchObject({ text: text.text, font_family: family })
    expect(collectPanelAnnotations([panel], [{ ...reopened, x: 1, y: 1, w: 20, h: 6 }]).get('p')?.objects[0]).toMatchObject({ font_family: family })
  })

  it('Times New Roman coverage and unavailable faces are independent of available Arial', () => {
    useCanvasFontRuntime.setState({ Arial: { available: true, faces: [
      { bold: false, italic: false, postscript_name: 'ArialMT', sha256: 'arial', primary: [[32, 126], [945, 945]] },
    ] } })
    expect(textDiagnostics('α', 'auto', { fontFamily: 'Times New Roman' }).unavailable).toBe(true)
    useCanvasFontRuntime.setState({ 'Times New Roman': { available: true, faces: [
      { bold: false, italic: false, postscript_name: 'TimesNewRomanPSMT', sha256: 'times', primary: [[32, 126]] },
      { bold: true, italic: true, postscript_name: 'TimesNewRomanPS-BoldItalicMT', sha256: 'times-bi', primary: [[32, 126], [945, 945]] },
    ] } })
    expect(textDiagnostics('α m⁻²', 'auto', { fontFamily: 'Times New Roman' })).toEqual({ missing: ['α'], substituted: [] })
    expect(textDiagnostics('α m⁻²', 'auto', { fontFamily: 'Times New Roman', bold: true, italic: true })).toEqual({ missing: [], substituted: [] })
    expect(textDiagnostics('a', 'auto', { fontFamily: 'Times New Roman', italic: true }).unavailable).toBe(true)
  })

  it.each([false, true])('toolbar text tool creates Arial with click/drag (drag=%s), including undo/redo', (drag) => {
    const x = mmToWorld(10)
    const y = mmToWorld(20)
    const down = { clientX: x, clientY: y, button: 0, stopPropagation() {} } as unknown as ReactPointerEvent
    useUiStore.setState({ tool: 'text' })
    startDraw(down, 'text')
    if (drag) window.dispatchEvent(new MouseEvent('pointermove', { clientX: x + 140, clientY: y + 30 }))
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: x + (drag ? 140 : 0), clientY: y + (drag ? 30 : 0) }))
    const text = useDocumentStore.getState().doc.objects[0] as TextObject
    expect(text).toMatchObject({ type: 'text', fontFamily: 'Arial', text: 'Text', sizePt: 20, bold: false })
    expect(useUiStore.getState().editingTextId).toBe(text.id)
    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().doc.objects).toEqual([])
    useDocumentStore.getState().redo()
    expect(useDocumentStore.getState().doc.objects[0]).toMatchObject({ id: text.id, fontFamily: 'Arial' })
  })

  it('symbol and scientific preset insertion use the same current-profile Arial defaults', () => {
    insertSymbol('α')
    expect(useDocumentStore.getState().doc.objects[0]).toMatchObject({ text: 'α', fontFamily: 'Arial', sizePt: 20, bold: false })
    const texts = PRESET_IDS.flatMap((id) => buildPreset(id, { x: 50, y: 50 })).filter((o) => o.type === 'text')
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.every((o) => o.fontFamily === 'Arial')).toBe(true)
  })

  it('toolbar and symbols preserve generic inheritance for an explicit upstream profile', () => {
    useDocumentStore.getState().silent((d) => { d.profile = { id: 'lab-publication-v1' } })
    startDraw({ clientX: 30, clientY: 40, button: 0, stopPropagation() {} } as unknown as ReactPointerEvent, 'text')
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 30, clientY: 40 }))
    insertSymbol('α')
    expect(useDocumentStore.getState().doc.objects.every((o) => o.type === 'text' && o.fontFamily === undefined)).toBe(true)
  })

  it('new BatFig text and panel labels serialize, reopen and export explicit Arial plus raw scientific markup', async () => {
    const text = addText({ text: 'α H_{2}O / mAh g^{-1}' })
    useDocumentStore.getState().silent((d) => { d.objects.push(panel) })
    addSubLabels()
    const texts = useDocumentStore.getState().doc.objects.filter((o) => o.type === 'text')
    expect(texts).toHaveLength(2)
    expect(texts.every((o) => o.fontFamily === 'Arial')).toBe(true)
    const saved = JSON.parse(JSON.stringify(useDocumentStore.getState().buildProject()))
    await useDocumentStore.getState().switchDocument(migrateToProject(saved)!, 'arial_reopened')
    const reopened = useDocumentStore.getState().doc.objects.find((o) => o.id === text.id) as TextObject
    expect(reopened).toMatchObject({ text: text.text, fontFamily: 'Arial', sizePt: 20, bold: false })
    expect(toExportObjects([reopened])[0]).toMatchObject({ text: text.text, font_family: 'Arial', size_pt: 20, bold: false })
    expect(collectPanelAnnotations([panel], [{ ...reopened, x: 1, y: 1, w: 20, h: 6 }]).get('p')?.objects[0]).toMatchObject({ font_family: 'Arial' })
  })

  it('an explicitly retained upstream profile keeps its existing new-text default', () => {
    useDocumentStore.getState().silent((d) => { d.profile = { id: 'lab-publication-v1' } })
    expect(addText().fontFamily).toBeUndefined()
  })

  it('unknown or missing Arial is blocking evidence, not a generic-font coverage verdict', () => {
    expect(textDiagnostics('a', 'auto', { fontFamily: 'Arial' })).toEqual({ missing: [], substituted: [], unavailable: true })
    const spec: PreflightSpec = {
      page: { w_mm: 100, h_mm: 80, margin_mm: 0 }, panels: [], objects: [],
      texts: [{ id: 't', text: 'a', size_pt: 10, bold: false, font_family: 'Arial', rect_mm: [0, 0, 10, 5], hidden: false }],
    }
    expect(runSpec(spec, loadProfile()).filter((i) => i.id === 'canvas-font-unavailable').map((i) => i.severity)).toEqual(['error'])
  })

  it('checks the requested face and synthesized superscript base characters against backend coverage', () => {
    useCanvasFontRuntime.setState({ Arial: { available: true, faces: [
      { bold: false, italic: false, postscript_name: 'ArialMT', sha256: 'test', primary: [[32, 126], [945, 945]] },
      { bold: true, italic: false, postscript_name: 'Arial-BoldMT', sha256: 'test-bold', primary: [[32, 126]] },
    ] } })
    expect(textDiagnostics('α m⁻²', 'auto', { fontFamily: 'Arial' })).toEqual({ missing: [], substituted: [] })
    expect(textDiagnostics('α', 'auto', { fontFamily: 'Arial', bold: true }).missing).toEqual(['α'])
    expect(textDiagnostics('中', 'auto', { fontFamily: 'Arial' }).missing).toEqual(['中'])
    expect(textDiagnostics('a', 'auto', { fontFamily: 'Arial', italic: true }).unavailable).toBe(true)
  })
})
