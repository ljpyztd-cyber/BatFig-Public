/**
 * 画布标签条的形（2026-09-15 打磨 B1 / B2 / T8）。
 *
 * 此前它只借了 `TAB_UNDERLINE` 那条线：选中态是 400 + ink，而右栏页签是 600 + ink
 * ——同一屏两种「选中」。下划线又画在整个 tab 上（含 × 那 20px），线比字宽。
 *
 * 三件事逐条钉：
 *   1. 选中态走 `tabClass`（600），与右栏页签同一副语法；
 *   2. 下划线挂在**文字盒**上，不是整个 tab；
 *   3. 加粗宽度先量后锁——切页签时邻居不挪（`ui/Tabs.tsx` 的 `Tab` 用同一手法）。
 *
 * jsdom 没有布局引擎，`getBoundingClientRect` 恒为 0，量不出真实宽度。所以第 3 条
 * 钉的是**那段逻辑跑过**（量完把 minWidth 写回内联样式），像素归真浏览器。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', async (original) => ({
  ...await original<typeof import('@/lib/api')>(),
  saveLayout: vi.fn(),
}))

import { CanvasTabs } from '@/components/CanvasTabs'
import { TooltipProvider } from '@/components/ui/Tooltip'
import { tabClass } from '@/components/ui/tabClass'
import { useDocumentStore } from '@/store/documentStore'
import { activateCanvas, dropCanvasSession } from '@/store/canvasSession'
import { useSelectionStore } from '@/store/selectionStore'
import { useUiStore } from '@/store/uiStore'
import { useViewportStore } from '@/store/viewportStore'
import { ApiError, saveLayout } from '@/lib/api'
import { answerLeaveRequest, cancelLeaveRequest, useLeaveGuard } from '@/lib/closeGuard'
import { bindNamedDocumentTarget } from '@/lib/namedSave'
import { setCurrentProjectId } from '@/lib/session'
import { literal } from '@/i18n'
import { canvasToDoc, emptyProject, type PanelObject, type ProjectDocument } from '@/types/document'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch

let root: Root
let host: HTMLDivElement

const mount = () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root.render(
      <TooltipProvider>
        <CanvasTabs />
      </TooltipProvider>,
    )
  })
}

const tabs = () => [...host.querySelectorAll('[role=tab]')] as HTMLElement[]
/** 一个 tab 里承载文字与下划线的那层 */
const nameBox = (t: HTMLElement) => t.firstElementChild as HTMLElement

beforeEach(async () => {
  cancelLeaveRequest()
  localStorage.clear()
  setCurrentProjectId('tabs-project')
  dropCanvasSession('c1')
  dropCanvasSession('c2')
  vi.mocked(saveLayout).mockReset().mockResolvedValue({ ok: true, revision: 'r2' })
  await useDocumentStore.getState().switchDocument(emptyProject(), 'd_tabs')
  const canvas = (id: string, name: string) => ({
    id,
    name,
    page: { w: 150, h: 100 },
    objects: [],
    guides: [],
  })
  useDocumentStore.setState({
    canvases: [canvas('c1', 'Figure 1'), canvas('c2', 'Figure 2')],
    openTabs: ['c1', 'c2'],
    activeCanvasId: 'c1',
    doc: { ...useDocumentStore.getState().doc, name: 'Figure 1' },
  })
})

afterEach(() => {
  cancelLeaveRequest()
  act(() => root.unmount())
  host.remove()
  useUiStore.getState().setStatus(null)
})

describe('画布标签条', () => {
  it('选中态与右栏页签同一副语法：`tabClass` 的 600 + ink', () => {
    mount()
    const [first, second] = tabs()
    expect(first.getAttribute('aria-selected')).toBe('true')
    // 钉的是**选中 / 未选中这两套词**取自 `tabClass`，不是把它整串抄一遍：
    // 共同的那几类（h-full 之流）会被 tab 自己的 h-9 合并掉，抄整串等于钉一件不成立的事
    const only = (a: string, b: string) => a.split(' ').filter((c) => !b.split(' ').includes(c))
    for (const cls of only(tabClass(true), tabClass(false))) {
      expect(first.className, '选中态的词来自 tabClass').toContain(cls)
    }
    for (const cls of only(tabClass(false), tabClass(true))) {
      expect(second.className, '未选中态的词来自 tabClass').toContain(cls)
    }
    expect(first.className, '选中 = 600').toContain('font-semibold')
    expect(second.className, '未选中不加粗').not.toContain('font-semibold')
  })

  it('条高 36：与右栏页签同档（此前 32）', () => {
    mount()
    for (const t of tabs()) expect(t.className).toContain('h-9')
  })

  it('下划线挂在文字盒上，不是整个 tab——可关闭的那个不会把线延到 × 底下', () => {
    mount()
    const [first, second] = tabs()
    // 线在里层那个 span 上，且铺满它（inset-x-0 = 文字宽）
    expect(nameBox(first).className).toContain('after:')
    expect(nameBox(first).className).toContain('after:inset-x-0')
    expect(first.className, 'tab 自己不再画线').not.toContain('after:inset-x-1.5')
    // 未选中的那个一条线都没有：tablist 上只有一条
    expect(nameBox(second).className).not.toContain('after:bg-ink')
  })

  it('左缘与品牌标同一条竖线：tab 自己没有左内边距（条的 px-3 就是那 12）', () => {
    mount()
    const [first] = tabs()
    expect(first.className).not.toContain('px-2.5')
    expect(first.className).not.toContain('px-6')
  })

  it('加粗宽度先量后锁：量宽那段真的跑过，minWidth 写回了内联样式', () => {
    // jsdom 的 getBoundingClientRect 恒为 0，effect 里 `w > 0` 不成立、不会写回——
    // 桩一个非零宽度，才量得到「那段逻辑有没有执行」
    const proto = Element.prototype
    const real = proto.getBoundingClientRect
    proto.getBoundingClientRect = function () {
      return { ...real.call(this), width: 48, height: 36 } as DOMRect
    }
    try {
      mount()
      for (const t of tabs()) {
        expect(nameBox(t).style.minWidth, '每个页签都锁了自己的加粗宽度').toBe('48px')
      }
    } finally {
      proto.getBoundingClientRect = real
    }
  })
})

describe('closing a canvas preserves the document session', () => {
  const store = () => useDocumentStore.getState()
  const view = () => {
    const { zoom, panX, panY } = useViewportStore.getState()
    return { zoom, panX, panY }
  }
  const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  const clickClose = async (id: string) => {
    const button = host.querySelector<HTMLButtonElement>(`[data-close-canvas="${id}"]`)
    expect(button).toBeInstanceOf(HTMLButtonElement)
    await act(async () => { button!.click(); await tick() })
  }
  const edit = (x: number) => store().commit(literal('move panel'), (doc) => { doc.objects[0].x = x })

  beforeEach(() => {
    const canvases = store().canvases.map((canvas, index) => ({
      ...canvas,
      objects: [{
        id: `p${index + 1}`, type: 'panel', fileId: `Fig${index + 1}.pdf`, fileKind: 'pdf',
        nativeW: 80, nativeH: 60, x: 10, y: 20, w: 40, h: 30, overrides: [],
      } satisfies PanelObject],
    }))
    useDocumentStore.setState({ canvases, doc: canvasToDoc(canvases[0]), canvasSessions: {} })
    useSelectionStore.getState().set(['p1'])
    useUiStore.setState({ elementPanelId: 'p1', selectedGids: ['axes_0'], editingTextId: null })
    useViewportStore.getState().setView({ zoom: 1.75, panX: -19, panY: 31 })
    bindNamedDocumentTarget({ name: 'two-panels', revision: 'r1' })
  })

  it('cancel leaves the active tab, content and undo history in place', async () => {
    edit(42)
    const before = store().doc
    const history = store().past
    mount()
    await clickClose('c1')
    expect(useLeaveGuard.getState().request).toMatchObject({ kind: 'canvas', canvasId: 'c1' })
    expect(store().openTabs).toEqual(['c1', 'c2'])
    await act(async () => { await answerLeaveRequest('cancel'); await tick() })
    expect(store().openTabs).toEqual(['c1', 'c2'])
    expect(store().activeCanvasId).toBe('c1')
    expect(store().doc).toBe(before)
    expect(store().past).toBe(history)
    expect(useSelectionStore.getState().ids).toEqual(['p1'])
    expect(saveLayout).not.toHaveBeenCalled()
  })

  it.each([500, 409])('save HTTP %i keeps the tab open, with its edit and history available', async (status) => {
    edit(42)
    vi.mocked(saveLayout).mockRejectedValueOnce(new ApiError('save failed', status, {}))
    mount()
    await clickClose('c1')
    await act(async () => { await answerLeaveRequest('save'); await tick() })
    expect(store().openTabs).toEqual(['c1', 'c2'])
    expect(store().activeCanvasId).toBe('c1')
    expect(store().doc.objects[0].x).toBe(42)
    expect(store().past).toHaveLength(1)
    expect(useLeaveGuard.getState().failed).toBe(true)
  })

  it('waits for disk success, then restores the closed canvas history and UI when reopened', async () => {
    edit(42)
    edit(61)
    store().undo()
    const oldPast = store().past
    const oldFuture = store().future
    const oldView = view()
    activateCanvas('c2')
    useSelectionStore.getState().set(['p2'])
    useUiStore.setState({ elementPanelId: 'p2', selectedGids: ['axes_1'] })
    useViewportStore.getState().setView({ zoom: 2, panX: 11, panY: -7 })
    const secondView = view()
    activateCanvas('c1')

    let finish!: (value: Awaited<ReturnType<typeof saveLayout>>) => void
    vi.mocked(saveLayout).mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    mount()
    await clickClose('c1')
    let saving!: ReturnType<typeof answerLeaveRequest>
    act(() => { saving = answerLeaveRequest('save') })
    expect(store().openTabs).toEqual(['c1', 'c2'])
    expect(store().activeCanvasId).toBe('c1')
    expect(useLeaveGuard.getState().busy).toBe(true)
    await act(async () => { finish({ ok: true, revision: 'r2' }); await saving; await tick() })
    expect(store().openTabs).toEqual(['c2'])
    expect(store().canvases).toHaveLength(2)
    expect(store().activeCanvasId).toBe('c2')
    expect(useSelectionStore.getState().ids).toEqual(['p2'])
    expect(view()).toEqual(secondView)
    expect(saveLayout).toHaveBeenCalledTimes(1)
    const savedDocument = vi.mocked(saveLayout).mock.calls[0][1] as ProjectDocument
    expect(savedDocument.canvases[0].objects[0].x).toBe(42)

    act(() => activateCanvas('c1', { open: true }))
    expect(store().doc.objects[0].x).toBe(42)
    expect(store().past).toEqual(oldPast)
    expect(store().future).toEqual(oldFuture)
    expect(useSelectionStore.getState().ids).toEqual(['p1'])
    expect(useUiStore.getState().selectedGids).toEqual(['axes_0'])
    expect(view()).toEqual(oldView)
    act(() => store().redo())
    expect(store().doc.objects[0].x).toBe(61)
  })

  it('closing a changed inactive tab does not change the active selection or viewport', async () => {
    activateCanvas('c2')
    edit(77)
    useSelectionStore.getState().set(['p2'])
    activateCanvas('c1')
    // Change the live UI after its prior snapshot: restoring the current canvas
    // while closing another tab must not roll these fresh choices back.
    useSelectionStore.getState().clear()
    useViewportStore.getState().setView({ zoom: 3, panX: 24, panY: -15 })
    const activeDoc = store().doc
    const activeView = view()
    mount()
    await clickClose('c2')
    await act(async () => { await answerLeaveRequest('discard'); await tick() })
    expect(store().openTabs).toEqual(['c1'])
    expect(store().activeCanvasId).toBe('c1')
    expect(store().doc).toBe(activeDoc)
    expect(useSelectionStore.getState().ids).toEqual([])
    expect(view()).toEqual(activeView)
    expect(saveLayout).not.toHaveBeenCalled()
    act(() => activateCanvas('c2', { open: true }))
    expect(store().doc.objects[0].x).toBe(77)
    expect(store().past).toHaveLength(1)
    expect(useSelectionStore.getState().ids).toEqual(['p2'])
  })
})
