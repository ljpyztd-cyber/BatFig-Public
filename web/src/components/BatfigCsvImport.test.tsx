import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BatfigCsvImport } from './BatfigCsvImport'
import { inspectCsv, importCsv } from '@/lib/batfigCsvApi'
import { setCurrentProjectId } from '@/lib/session'
import { useScriptRunStore } from '@/store/scriptRunStore'
import { useRuntimeAssetStore } from '@/store/runtimeAssetStore'
import { addFigureToLayout } from '@/store/workspace'

vi.mock('@/lib/batfigCsvApi', () => ({ inspectCsv: vi.fn(), importCsv: vi.fn() }))
vi.mock('@/store/workspace', async (original) => ({
  ...await original<typeof import('@/store/workspace')>(), addFigureToLayout: vi.fn(),
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
const facts = { columns: [{ name: 'x', index: 0, numeric: true }, { name: 'y', index: 1, numeric: true }],
  row_count: 2, sha256: 'a'.repeat(64), byte_count: 12 }
const query = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!

beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(addFigureToLayout).mockReturnValue('added')
  setCurrentProjectId('project-a')
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<BatfigCsvImport />))
  await act(async () => query<HTMLButtonElement>('[data-csv-import-open]').click())
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  setCurrentProjectId(null)
})

async function selectFile() {
  const input = query<HTMLInputElement>('[data-csv-file]')
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x,y\n0,1\n'], 'test.csv')] })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
}

it('inspects before enabling import and sends explicit source mapping', async () => {
  expect(query<HTMLButtonElement>('[data-csv-create]').disabled).toBe(true)
  vi.mocked(inspectCsv).mockResolvedValue(facts)
  vi.mocked(importCsv).mockResolvedValue({ script: 'csv/figure.py', sha256: facts.sha256 })
  const run = vi.spyOn(useScriptRunStore.getState(), 'run').mockImplementation(async () => {
    useScriptRunStore.setState({ byScript: { 'csv/figure.py': {
      phase: 'captured_one', descriptors: [{ asset_id: 'runtime:csv/figure.py#curve' } as never],
      error: null, cancelRequested: false, droppedFigures: 0, gen: 1,
    } } })
  })
  vi.spyOn(useRuntimeAssetStore.getState(), 'loadAssets').mockResolvedValue(undefined)
  await selectFile()
  expect(query<HTMLButtonElement>('[data-csv-create]').disabled).toBe(false)
  await act(async () => query<HTMLButtonElement>('[data-csv-create]').click())
  expect(importCsv).toHaveBeenCalledWith(expect.any(File), {
    x: 'x', ys: ['y'], x_label: 'x', y_label: 'y', title: '',
  }, 'project-a')
  expect(run).toHaveBeenCalledWith('csv/figure.py')
  expect(addFigureToLayout).toHaveBeenCalledWith('runtime:csv/figure.py#curve')
})

it('does not add an old import to a newly selected project', async () => {
  vi.mocked(inspectCsv).mockResolvedValue(facts)
  vi.mocked(importCsv).mockImplementation(async () => {
    setCurrentProjectId('project-b')
    return { script: 'csv/figure.py', sha256: facts.sha256 }
  })
  const run = vi.spyOn(useScriptRunStore.getState(), 'run').mockResolvedValue(undefined)
  await selectFile()
  await act(async () => query<HTMLButtonElement>('[data-csv-create]').click())
  expect(run).not.toHaveBeenCalled()
  expect(addFigureToLayout).not.toHaveBeenCalled()
})

it('shows inspection failure and keeps create disabled', async () => {
  vi.mocked(inspectCsv).mockRejectedValue(new Error('CSV invalid: duplicate columns'))
  await selectFile()
  expect(query('[data-csv-error]').textContent).toContain('duplicate columns')
  expect(query<HTMLButtonElement>('[data-csv-create]').disabled).toBe(true)
})

it('shows unusable numeric columns and the offending record instead of hiding them', async () => {
  vi.mocked(inspectCsv).mockResolvedValue({ ...facts, columns: [facts.columns[0], {
    name: 'y', index: 1, numeric: false, error: "Record 3, column 'y' is NaN or infinite.",
  }] })
  await selectFile()
  expect(query<HTMLInputElement>('[data-csv-y="y"]').disabled).toBe(true)
  expect(query('[data-csv-column-error="y"]').textContent).toContain('Record 3')
  expect(query<HTMLButtonElement>('[data-csv-create]').disabled).toBe(true)
  expect(importCsv).not.toHaveBeenCalled()
})

it('keeps failed canvas insertion open and retries without importing a duplicate bundle', async () => {
  vi.mocked(inspectCsv).mockResolvedValue(facts)
  vi.mocked(importCsv).mockResolvedValue({ script: 'csv/figure.py', sha256: facts.sha256 })
  vi.spyOn(useScriptRunStore.getState(), 'run').mockImplementation(async () => {
    useScriptRunStore.setState({ byScript: { 'csv/figure.py': {
      phase: 'captured_one', descriptors: [{ asset_id: 'runtime:csv/figure.py#curve' } as never],
      error: null, cancelRequested: false, droppedFigures: 0, gen: 1,
    } } })
  })
  // The asset store catches refresh failures; the caller must inspect the
  // insertion outcome even though loadAssets resolves successfully.
  vi.spyOn(useRuntimeAssetStore.getState(), 'loadAssets').mockResolvedValue(undefined)
  vi.mocked(addFigureToLayout).mockReturnValueOnce('missing').mockReturnValueOnce('added')
  await selectFile()
  await act(async () => query<HTMLButtonElement>('[data-csv-create]').click())
  expect(query('[data-csv-error]').textContent).toContain('runtime:csv/figure.py#curve')
  expect(query<HTMLButtonElement>('[data-csv-create]').disabled).toBe(false)
  await act(async () => query<HTMLButtonElement>('[data-csv-create]').click())
  expect(importCsv).toHaveBeenCalledTimes(1)
  expect(addFigureToLayout).toHaveBeenCalledTimes(2)
  expect(document.querySelector('[data-csv-create]')).toBeNull()
})
