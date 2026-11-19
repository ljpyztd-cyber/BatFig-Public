import { jsonFetch } from './api'

export interface CsvInspection {
  columns: { name: string; index: number; numeric: boolean; error?: string }[]
  row_count: number
  sha256: string
  byte_count: number
}

export interface CsvMapping {
  x: string
  ys: string[]
  x_label: string
  y_label: string
  title: string
}

function upload(file: File, mapping?: CsvMapping) {
  const body = new FormData()
  body.append('file', file)
  if (mapping) body.append('mapping', JSON.stringify(mapping))
  return { method: 'POST', body }
}

export const inspectCsv = (file: File, project: string | null) =>
  jsonFetch<CsvInspection>('/api/batfig/csv/inspect', upload(file), project)

export const importCsv = (file: File, mapping: CsvMapping, project: string | null) =>
  jsonFetch<{ script: string; sha256: string }>('/api/batfig/csv/import', upload(file, mapping), project)
