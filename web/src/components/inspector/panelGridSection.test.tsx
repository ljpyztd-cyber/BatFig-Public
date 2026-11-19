import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '@/i18n'
import type { PanelGridSettings } from '@/lib/panelGrid'
import { PanelGridSection } from './PanelGridSection'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const defaults: PanelGridSettings = {
  cols: 3, ratio: 4 / 3, gap: 3, margin: 8, axisFontSizePt: 12,
  basis: 'axes', columnAlign: 'start', rowAlign: 'end',
}
let host: HTMLDivElement
let root: Root
const onApply = vi.fn()
const onPrepare = vi.fn()
type Props = Parameters<typeof PanelGridSection>[0]
async function mount(props: Partial<Props> = {}) {
  await act(async () => root.render(<PanelGridSection value={defaults} panelCount={9}
    onApply={onApply} scopeKey="canvas-a" {...props} />))
}
const button = (selector: string) => host.querySelector<HTMLButtonElement>(selector)!
const field = (name: string) => host.querySelector<HTMLInputElement>(`[data-inspector-prop="panel-grid-${name}"]`)!
async function click(selector: string) {
  await act(async () => button(selector).click())
}
async function typeNumber(name: string, text: string, commit = true) {
  const input = field(name)
  await act(async () => {
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  if (commit) await act(async () => input.blur())
}
beforeEach(async () => {
  await setLocale('zh-CN')
  onApply.mockReset()
  onPrepare.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  await setLocale('zh-CN')
})

describe('canvas figure grid controls', () => {
  it('shows the default grid and 12 pt axis text without mutating anything', async () => {
    await mount()
    expect(host.querySelector('[data-panel-grid-summary]')?.textContent).toContain('3 行 × 3 列')
    expect(field('columns').value).toBe('3')
    expect(field('gap').value).toBe('3')
    expect(button('[data-panel-grid-gap="3"]').getAttribute('aria-pressed')).toBe('true')
    expect(field('margin').value).toBe('8')
    expect(field('axis-font-size').value).toBe('12')
    expect(button('[data-panel-grid-ratio="4:3"]').getAttribute('aria-pressed')).toBe('true')
    for (const [group, selected] of [['basis', 'axes'], ['column-align', 'start'], ['row-align', 'end']]) {
      expect(button(`[data-testid="panel-grid-${group}"] [data-value="${selected}"]`).getAttribute('aria-checked')).toBe('true')
    }
    expect(onApply).not.toHaveBeenCalled()
  })

  it('keeps typed values local and submits their final values once, including a still-focused input', async () => {
    await mount()
    await typeNumber('columns', '2')
    await typeNumber('margin', '10')
    await typeNumber('axis-font-size', '11.5')
    await typeNumber('gap', '7.25', false)
    expect(onApply).not.toHaveBeenCalled()
    await click('[data-panel-grid-apply]')
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ ...defaults, cols: 2, margin: 10, gap: 7.25, axisFontSizePt: 11.5 })
    expect(field('gap').value).toBe('7.25')
  })

  it('ratio and spacing shortcuts apply once immediately and retain the other draft settings', async () => {
    await mount()
    await typeNumber('axis-font-size', '14.5')
    await typeNumber('columns', '2', false)
    await click('[data-panel-grid-ratio="16:9"]')
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ ...defaults, cols: 2, ratio: 16 / 9, axisFontSizePt: 14.5 })
    onApply.mockClear()
    await click('[data-panel-grid-gap="3"]')
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ ...defaults, cols: 2, ratio: 16 / 9, gap: 3, axisFontSizePt: 14.5 })
  })

  it('alignment and basis choices apply immediately with independent row and column meanings', async () => {
    await mount()
    await click('[data-testid="panel-grid-column-align"] [data-value="end"]')
    expect(onApply).toHaveBeenLastCalledWith({ ...defaults, columnAlign: 'end' })
    await click('[data-testid="panel-grid-row-align"] [data-value="start"]')
    expect(onApply).toHaveBeenLastCalledWith({ ...defaults, columnAlign: 'end', rowAlign: 'start' })
    await click('[data-testid="panel-grid-basis"] [data-value="image"]')
    expect(onApply).toHaveBeenLastCalledWith({ ...defaults, columnAlign: 'end', rowAlign: 'start', basis: 'image' })
    expect(onApply).toHaveBeenCalledTimes(3)
  })

  it('document changes and canvas switches discard old local number drafts', async () => {
    await mount()
    await typeNumber('gap', '12')
    await mount({ value: { ...defaults, gap: 4 } })
    expect(field('gap').value).toBe('4')
    await typeNumber('gap', '15', false)
    await mount({ scopeKey: 'canvas-b' })
    expect(field('gap').value).toBe('3')
    await click('[data-panel-grid-apply]')
    expect(onApply).toHaveBeenCalledExactlyOnceWith(defaults)
  })

  it('flushes a focused axis font draft on apply and resets it when the saved size changes', async () => {
    await mount()
    await typeNumber('axis-font-size', '13.5', false)
    expect(onApply).not.toHaveBeenCalled()
    await click('[data-panel-grid-apply]')
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ ...defaults, axisFontSizePt: 13.5 })
    await typeNumber('axis-font-size', '15')
    await mount({ value: { ...defaults, axisFontSizePt: 11 } })
    expect(field('axis-font-size').value).toBe('11')
  })

  it('pending axes offers explicit preparation while image-bounds layout remains reachable', async () => {
    await mount({ status: 'pending', message: '等待坐标轴', onPrepare })
    expect(host.querySelector('[data-panel-grid-message]')?.textContent).toBe('等待坐标轴')
    await click('[data-panel-grid-prepare]')
    expect(onPrepare).toHaveBeenCalledOnce()
    expect(onApply).not.toHaveBeenCalled()
    await click('[data-testid="panel-grid-basis"] [data-value="image"]')
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ ...defaults, basis: 'image' })
  })

  it.each([{ panelCount: 0 }, { disabled: true }])('disables every write control when unavailable: %j', async (props) => {
    await mount(props)
    expect([...host.querySelectorAll('button,input')].every((control) => (control as HTMLInputElement).disabled)).toBe(true)
    await click('[data-panel-grid-apply]')
    await click('[data-panel-grid-ratio="1:1"]')
    expect(onApply).not.toHaveBeenCalled()
  })

  it('renders and switches English labels in place', async () => {
    await mount()
    await act(async () => setLocale('en-US'))
    expect(button('[data-panel-grid-apply]').textContent).toBe('Apply to whole canvas')
    expect(host.querySelector('[data-panel-grid-summary]')?.textContent).toBe('9 figures · 3 × 3 grid')
    expect(host.textContent).toContain('Axes mode matches main plot proportions')
    expect(field('axis-font-size').getAttribute('aria-label')).toBe('Axis text size')
    expect(host.querySelector('[data-panel-grid-axis-font-hint]')?.textContent).toContain('final page size')
    expect(host.textContent).not.toContain('panelGrid.')
  })
})
