import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, jsonFetch } from '@/lib/api'
import { useDocumentStore } from '@/store/documentStore'
import { useUiStore } from '@/store/uiStore'
import { emptyProject, type TextObject } from '@/types/document'
import { TextView } from './TextView'
import { mmToWorld } from '@/store/viewportStore'
import { msg } from '@/i18n'

vi.mock('@/lib/api', async (original) => ({
  ...await original<typeof import('@/lib/api')>(), jsonFetch: vi.fn(),
}))

const obj: TextObject = {
  id: 'arial1', type: 'text', text: '(a) α H_{2}O / mAh g^{-1}', fontFamily: 'Arial',
  x: 7, y: 8, w: 40, h: 5, sizePt: 10, bold: false, color: '#000000', align: 'left',
}
const result = { png_base64: 'cG5n', width_mm: 40, height_mm: 12, font_family: 'Arial' }
let root: Root
let container: HTMLDivElement

function Scene() {
  const text = useDocumentStore((s) => s.doc.objects[0]) as TextObject
  return <TextView obj={text} />
}

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
  // The regression also needs the legacy branch to run when deliberately
  // mutated, so failure measures missing exact pixels, not a jsdom API gap.
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.mocked(jsonFetch).mockReset().mockResolvedValue(result)
  localStorage.clear()
  useUiStore.setState({ editingTextId: null })
  await useDocumentStore.getState().switchDocument(emptyProject(), 'arial_preview')
  useDocumentStore.getState().silent((d) => { d.objects.push({ ...obj }) })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe.each(['Arial', 'Times New Roman'] as const)('%s exact RenderCore preview', (family) => {
  beforeEach(() => {
    useDocumentStore.getState().silent((d) => { (d.objects[0] as TextObject).fontFamily = family })
    vi.mocked(jsonFetch).mockResolvedValue({ ...result, font_family: family })
  })
  it('renders backend pixels with natural multiline height and unrotated local coordinates', async () => {
    await act(async () => root.render(<Scene />))
    const image = container.querySelector('img')!
    expect(image).not.toBeNull()
    expect(image.src).toBe('data:image/png;base64,cG5n')
    expect(image.alt).toBe(obj.text)
    expect(useDocumentStore.getState().doc.objects[0].h).toBe(12)
    expect(container.querySelector('[data-exact-font-preview]')?.getAttribute('data-exact-font-preview')).toBe('ready')
    expect(container.querySelector('[data-font-family]')?.getAttribute('data-font-family')).toBe(family)
    const [, request] = vi.mocked(jsonFetch).mock.calls[0]
    expect(JSON.parse(request!.body as string).object).toMatchObject({
      x_mm: 0, y_mm: 0, text: obj.text, font_family: family,
    })
    expect(container.textContent).toBe('')
  })

  it('missing family is a visible error, never browser-substituted source text', async () => {
    vi.mocked(jsonFetch).mockRejectedValue(new ApiError(`Missing ${family}`, 422, { code: 'local_font_missing', params: { family } }))
    await act(async () => root.render(<Scene />))
    expect(container.querySelector('[data-exact-font-preview="error"]')).not.toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain(family)
    expect(container.textContent).not.toContain(obj.text)
  })

  it('displays glyph and border overflow without changing the semantic object box', async () => {
    vi.mocked(jsonFetch).mockResolvedValue({
      ...result, image_width_mm: 44, image_height_mm: 15, offset_x_mm: -2, offset_y_mm: -1,
    })
    await act(async () => root.render(<Scene />))
    const image = container.querySelector('img')!
    expect(parseFloat(image.style.left)).toBeCloseTo(mmToWorld(-2))
    expect(parseFloat(image.style.top)).toBeCloseTo(mmToWorld(-1))
    expect(parseFloat(image.style.width)).toBeCloseTo(mmToWorld(44))
    expect(parseFloat(image.style.height)).toBeCloseTo(mmToWorld(15))
    expect(useDocumentStore.getState().doc.objects[0]).toMatchObject({ w: 40, h: 12 })
    expect((container.querySelector('[data-exact-font-preview]') as HTMLElement).style.overflow).toBe('visible')
  })

  it('late results from replaced source cannot overwrite the current preview', async () => {
    let resolveFirst: (value: unknown) => void = () => {}
    vi.mocked(jsonFetch).mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
    await act(async () => root.render(<Scene />))
    await act(async () => {
      useDocumentStore.getState().silent((d) => { (d.objects[0] as TextObject).text = 'β' })
    })
    await act(async () => { resolveFirst({ ...result, png_base64: 'b2xk' }) })
    expect(container.querySelector('img')?.src).toBe('data:image/png;base64,cG5n')
    expect(container.querySelector('img')?.alt).toBe('β')
  })

  it('labels the editable source and commits one raw string while preserving the selected family', async () => {
    await act(async () => root.render(<Scene />))
    await act(async () => useUiStore.getState().setEditingText(obj.id))
    const source = container.querySelector('[data-exact-font-source-editor]')!
    expect(source.textContent).toContain(family)
    const editor = source.querySelector('[contenteditable]') as HTMLElement
    const next = 'ΔE / kJ mol^{-1}'
    editor.innerText = next
    await act(async () => { editor.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(useDocumentStore.getState().doc.objects[0]).toMatchObject({ text: next, fontFamily: family })
    expect(container.querySelector('img')?.alt).toBe(next)
  })

  it('a late response for the previous font cannot replace the selected font or its metrics', async () => {
    let resolveFirst: (value: unknown) => void = () => {}
    vi.mocked(jsonFetch).mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
    await act(async () => root.render(<Scene />))
    const next = family === 'Arial' ? 'Times New Roman' : 'Arial'
    vi.mocked(jsonFetch).mockResolvedValue({ ...result, font_family: next, height_mm: 9 })
    await act(async () => {
      useDocumentStore.getState().commit(msg('history.editText', undefined, 'inspector'), (d) => {
        (d.objects[0] as TextObject).fontFamily = next
      })
    })
    await act(async () => { resolveFirst({ ...result, font_family: family, png_base64: 'b2xk', height_mm: 30 }) })
    expect(container.querySelector('img')?.src).toBe('data:image/png;base64,cG5n')
    expect(container.querySelector('[data-font-family]')?.getAttribute('data-font-family')).toBe(next)
    expect(useDocumentStore.getState().doc.objects[0]).toMatchObject({ fontFamily: next, h: 9 })
    const [, request] = vi.mocked(jsonFetch).mock.calls.at(-1)!
    expect(JSON.parse(request!.body as string).object.font_family).toBe(next)
  })
})
