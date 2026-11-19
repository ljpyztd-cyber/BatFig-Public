/**
 * `ColorField` 的「无」状态（#427）：引擎报 `none` = 这条没有颜色（没设边色的形状、
 * `fill` 关着的面、空心 marker）。之前 `to_hex` 丢掉 alpha，透明黑显示成 #000000——
 * 检查器摆出一条并不存在的黑边。色块要画成「无」而不是黑色；取色盘只吃合法色号，
 * 喂它黑色当起点，用户一取色就得到一个真的颜色。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ColorField, NO_COLOR } from './Input'
import { finishActiveGesture, hasActiveGesture, resetGestureCoordinator } from '@/store/gestureCoordinator'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  resetGestureCoordinator()
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('ColorField 的「无」', () => {
  it('none 画成「无」色块：不是黑色，title 说「无」，取色盘拿到的是合法色号', async () => {
    await act(async () => {
      root.render(<ColorField value={NO_COLOR} onChange={() => {}} ariaLabel="边色" />)
    })
    const swatch = host.querySelector('[data-none]') as HTMLElement
    expect(swatch).not.toBeNull()
    expect(swatch.title).not.toMatch(/^#/)
    expect(swatch.title).not.toBe('NONE')
    // 色块里没有一层 background 是 none / 黑
    const fills = Array.from(swatch.querySelectorAll('div')).map((d) => d.style.background)
    expect(fills).not.toContain('none')
    expect(fills).not.toContain('rgb(0, 0, 0)')
    const input = host.querySelector('input[type=color]') as HTMLInputElement
    expect(input.value).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('真颜色照旧：色块就是那个色，title 是色号', async () => {
    await act(async () => {
      root.render(<ColorField value="#ff00ff" onChange={() => {}} ariaLabel="边色" />)
    })
    expect(host.querySelector('[data-none]')).toBeNull()
    const input = host.querySelector('input[type=color]') as HTMLInputElement
    expect(input.value).toBe('#ff00ff')
    expect((input.parentElement as HTMLElement).title).toBe('#FF00FF')
  })

  it('从「无」取色：发出去的是取色盘的色号，不是 none', async () => {
    const onChange = vi.fn()
    await act(async () => {
      root.render(<ColorField value={NO_COLOR} onChange={onChange} ariaLabel="边色" />)
    })
    const input = host.querySelector('input[type=color]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '#123456')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith('#123456')
  })
})

describe('ColorField draft lifecycle', () => {
  const input = () => host.querySelector<HTMLInputElement>('input[type=color]')!
  const sample = (value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('100 input samples make no document writes; change flushes the last sample exactly once without blur', async () => {
    const onChange = vi.fn()
    const end = vi.fn()
    const preview = vi.fn()
    await act(async () => root.render(<ColorField ariaLabel="Color" value="#112233" onChange={onChange} onGestureEnd={end} onPreview={preview} />))
    await act(async () => {
      for (let i = 0; i < 100; i++) sample(`#ff00${i.toString(16).padStart(2, '0')}`)
    })
    expect(onChange).not.toHaveBeenCalled()
    expect(end).not.toHaveBeenCalled()
    expect(hasActiveGesture()).toBe(true)
    await act(async () => input().dispatchEvent(new Event('change', { bubbles: true })))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('#ff0063')
    expect(end).toHaveBeenCalledTimes(1)
    expect(hasActiveGesture()).toBe(false)
    await act(async () => input().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('cancel restores the swatch and preview without writing any value', async () => {
    const onChange = vi.fn()
    const preview = vi.fn()
    await act(async () => root.render(<ColorField ariaLabel="Color" value="#112233" onChange={onChange} onPreview={preview} />))
    await act(async () => sample('#abcdef'))
    await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(input().value).toBe('#112233')
    expect(onChange).not.toHaveBeenCalled()
    expect(preview).toHaveBeenLastCalledWith(null)
    expect(hasActiveGesture()).toBe(false)
  })

  it('the native final value wins over an older draft, including cancel-to-original', async () => {
    const onChange = vi.fn()
    await act(async () => root.render(<ColorField ariaLabel="Color" value="#112233" onChange={onChange} />))
    await act(async () => {
      sample('#abcdef')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), '#112233')
      input().dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).not.toHaveBeenCalled()
    expect(input().value).toBe('#112233')
    await act(async () => {
      sample('#abcdef')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), '#123456')
      input().dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledExactlyOnceWith('#123456')
  })

  it('save/discrete actions flush the pending final value even without a native change', async () => {
    const onChange = vi.fn()
    await act(async () => root.render(<ColorField ariaLabel="Color" value="#112233" onChange={onChange} />))
    await act(async () => sample('#abc123'))
    await act(async () => finishActiveGesture())
    expect(onChange).toHaveBeenCalledExactlyOnceWith('#abc123')
  })

  it('pointer cancellation cancels a pending preview frame and creates no edit', async () => {
    const onChange = vi.fn()
    const preview = vi.fn()
    await act(async () => root.render(<ColorField ariaLabel="Color" value="#112233" onChange={onChange} onPreview={preview} />))
    await act(async () => {
      sample('#abcdef')
      input().dispatchEvent(new Event('pointercancel', { bubbles: true }))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
    expect(onChange).not.toHaveBeenCalled()
    expect(preview.mock.calls).toEqual([[null]])
  })

  it('a reused control cancels the old scope even if both targets have the same color', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const preview = vi.fn()
    await act(async () => root.render(<ColorField scopeKey="first" ariaLabel="Color" value="#112233" onChange={first} onPreview={preview} />))
    const oldInput = input()
    await act(async () => sample('#abcdef'))
    await act(async () => root.render(<ColorField scopeKey="second" ariaLabel="Color" value="#112233" onChange={second} onPreview={preview} />))
    expect(input()).not.toBe(oldInput)
    expect(input().value).toBe('#112233')
    await act(async () => oldInput.dispatchEvent(new Event('change', { bubbles: true })))
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    expect(preview).toHaveBeenLastCalledWith(null)
    expect(hasActiveGesture()).toBe(false)
  })

  it('a pending draft keeps its original writer when callbacks rerender and the field unmounts', async () => {
    const first = vi.fn()
    const second = vi.fn()
    await act(async () => root.render(<ColorField ariaLabel="Color" value="#112233" onChange={first} />))
    await act(async () => sample('#abcdef'))
    await act(async () => root.render(<ColorField ariaLabel="Color" value="#112233" onChange={second} />))
    await act(async () => root.render(null))
    expect(first).toHaveBeenCalledExactlyOnceWith('#abcdef')
    expect(second).not.toHaveBeenCalled()
  })

  it('presets expose common colors plus named combinations and choose one color in one edit', async () => {
    const onChange = vi.fn()
    await act(async () => root.render(<ColorField ariaLabel="Color" value="#112233" onChange={onChange} />))
    await act(async () => host.querySelector<HTMLButtonElement>('[data-color-presets-trigger]')!.click())
    const panel = document.querySelector('[data-color-presets]')!
    expect(panel.querySelectorAll('[data-color-sample]').length).toBeGreaterThan(40)
    expect(panel.textContent).toContain('经典配色')
    await act(async () => panel.querySelector<HTMLButtonElement>('[data-color-sample="#003f5c"]')!.click())
    expect(onChange).toHaveBeenCalledExactlyOnceWith('#003f5c')
    expect(document.querySelector('[data-color-presets]')).toBeNull()
  })
})
