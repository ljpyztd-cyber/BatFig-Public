import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/Tooltip'
import { CustomColormapEditor } from './CustomColormapEditor'

let root: Root | undefined
async function mount(onApply = vi.fn(), onClose = vi.fn()) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<TooltipProvider><CustomColormapEditor value={null}
    onApply={onApply} onClose={onClose} /></TooltipProvider>))
  return { onApply, onClose }
}
async function click(selector: string) {
  const button = document.querySelector<HTMLButtonElement>(selector)
  expect(button).not.toBeNull()
  await act(async () => button!.click())
}
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
})

describe('DIY color map draft', () => {
  it('presets, extra stops and reversing remain a local draft until Apply', async () => {
    const { onApply } = await mount()
    expect(document.querySelectorAll('[data-cmap-stop]')).toHaveLength(3)
    await click('[data-cmap-preset="blueGold"]')
    expect(document.querySelectorAll('[data-cmap-stop]')).toHaveLength(5)
    await click('[data-cmap-add]')
    expect(document.querySelectorAll('[data-cmap-stop]')).toHaveLength(6)
    await click('[data-cmap-reverse]')
    expect(onApply).not.toHaveBeenCalled()
    await click('[data-cmap-apply]')
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply.mock.calls[0][0]).toMatchObject({ type: 'custom', colors: expect.arrayContaining(['#d98e04']) })
    expect(onApply.mock.calls[0][0].colors[0]).toBe('#d98e04')
  })
  it('retains at least three stops and fixed endpoints', async () => {
    await mount()
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-cmap-remove]'))
      expect(button.disabled).toBe(true)
    await click('[data-cmap-add]')
    await click('[data-cmap-remove="1"]')
    expect(document.querySelectorAll('[data-cmap-stop]')).toHaveLength(3)
  })
})
