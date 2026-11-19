import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonFetch } from './api'
import { exactFontFace, refreshCanvasFonts, useCanvasFontRuntime, type CanvasFontStatus } from './canvasFontRuntime'

vi.mock('./api', () => ({ jsonFetch: vi.fn() }))

const status: CanvasFontStatus = { available: true, faces: [
  { bold: false, italic: false, postscript_name: 'TimesNewRomanPSMT', sha256: 'times', primary: [[32, 126]] },
] }

beforeEach(() => {
  vi.mocked(jsonFetch).mockReset()
  useCanvasFontRuntime.setState({ Arial: null, 'Times New Roman': null, failed: false })
})

describe('backend font facts', () => {
  it('shares an in-flight request and retains separate exact font faces', async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ Arial: { available: false, faces: [] }, 'Times New Roman': status })
    await Promise.all([refreshCanvasFonts(), refreshCanvasFonts()])
    expect(jsonFetch).toHaveBeenCalledTimes(1)
    expect(exactFontFace('Arial')).toBeUndefined()
    expect(exactFontFace('Times New Roman')?.postscript_name).toBe('TimesNewRomanPSMT')
    expect(exactFontFace('Times New Roman', true)).toBeUndefined()
  })

  it('an older backend with no Times entry clears previous Times evidence', async () => {
    useCanvasFontRuntime.setState({ 'Times New Roman': status })
    vi.mocked(jsonFetch).mockResolvedValue({ Arial: { available: false, faces: [] } })
    await refreshCanvasFonts()
    expect(exactFontFace('Times New Roman')).toBeUndefined()
    expect(useCanvasFontRuntime.getState().failed).toBe(false)
  })

  it('refresh failure invalidates stale coverage instead of certifying an unavailable font', async () => {
    useCanvasFontRuntime.setState({ 'Times New Roman': status })
    vi.mocked(jsonFetch).mockRejectedValue(new Error('offline'))
    await refreshCanvasFonts()
    expect(exactFontFace('Times New Roman')).toBeUndefined()
    expect(useCanvasFontRuntime.getState().failed).toBe(true)
  })
})
