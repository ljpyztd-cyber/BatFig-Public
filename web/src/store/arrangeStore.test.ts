import { describe, expect, it } from 'vitest'
import { useArrangeStore } from './arrangeStore'

describe('arrangeStore', () => {
  it('默认参照是选区（沿用 ArrangeSection 原来的默认）', () => {
    expect(useArrangeStore.getState().alignRef).toBe('selection')
  })
  it('默认按坐标轴对齐；重复设置不通知订阅者', () => {
    expect(useArrangeStore.getState().alignBasis).toBe('axes')
    const before = useArrangeStore.getState()
    before.setAlignBasis('axes')
    expect(useArrangeStore.getState()).toBe(before)
    before.setAlignBasis('image')
    expect(useArrangeStore.getState().alignBasis).toBe('image')
    before.setAlignBasis('axes')
  })
  it('设置同一个值不产生新状态对象（订阅者不白渲染）', () => {
    const before = useArrangeStore.getState()
    useArrangeStore.getState().setAlignRef('selection')
    expect(useArrangeStore.getState()).toBe(before)
    useArrangeStore.getState().setAlignRef('page')
    expect(useArrangeStore.getState().alignRef).toBe('page')
    useArrangeStore.getState().setAlignRef('selection')
  })
})
