import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatMessage, msg, type UiMessage } from '@/i18n'
import { backendCodeMsg, backendErrorMsg } from '@/lib/api'
import { importCsv, inspectCsv, type CsvInspection } from '@/lib/batfigCsvApi'
import { currentProjectId } from '@/lib/session'
import { useProjectStore } from '@/store/projectStore'
import { useScriptRunStore } from '@/store/scriptRunStore'
import { useRuntimeAssetStore } from '@/store/runtimeAssetStore'
import { addFigureToLayout } from '@/store/workspace'
import { Button } from './ui/Button'
import { Checkbox } from './ui/Checkbox'
import { Dialog } from './ui/Dialog'
import { TextInput } from './ui/Input'
import { Select } from './ui/Select'

/** Original data/spec live alongside the source; canvas edits stay in the document. */
export function BatfigCsvImport() {
  const { t } = useTranslation('workspace')
  const project = useProjectStore((s) => s.project?.id)
  const [open, setOpen] = useState(false)
  return <>
    <Button data-csv-import-open variant="secondary" onClick={() => setOpen(true)}>
      {t('csvImport.open')}
    </Button>
    {open && <CsvDialog key={project ?? 'default'} onClose={() => setOpen(false)} />}
  </>
}

function CsvDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('workspace')
  const project = useRef(currentProjectId()).current
  const mounted = useRef(true)
  const sequence = useRef(0)
  const imported = useRef<{ file: File; mapping: string; script: string } | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [inspection, setInspection] = useState<CsvInspection | null>(null)
  const [x, setX] = useState('')
  const [ys, setYs] = useState<string[]>([])
  const [xLabel, setXLabel] = useState('')
  const [yLabel, setYLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<UiMessage | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const current = () => mounted.current && currentProjectId() === project

  async function choose(selected: File | undefined) {
    const seq = ++sequence.current
    setFile(selected ?? null); setInspection(null); setError(null)
    if (!selected) return
    setBusy(true)
    try {
      const result = await inspectCsv(selected, project)
      if (!current() || seq !== sequence.current) return
      setInspection(result)
      const numeric = result.columns.filter((c) => c.numeric)
      setX(numeric[0]?.name ?? '')
      setYs(numeric.slice(1).map((c) => c.name))
      setXLabel(numeric[0]?.name ?? '')
      setYLabel(numeric.length === 2 ? numeric[1].name : '')
    } catch (e) {
      if (current() && seq === sequence.current) setError(backendErrorMsg(e))
    } finally {
      if (current() && seq === sequence.current) setBusy(false)
    }
  }

  async function create() {
    if (!file || !x || ys.length === 0 || busy) return
    setBusy(true); setError(null)
    try {
      const mapping = { x, ys, x_label: xLabel, y_label: yLabel, title: '' }
      const signature = JSON.stringify(mapping)
      const previous = imported.current
      const bundle = previous?.file === file && previous.mapping === signature
        ? previous
        : await importCsv(file, mapping, project)
      if (!current()) return
      imported.current = { file, mapping: signature, script: bundle.script }
      const epoch = useScriptRunStore.getState().epoch
      await useScriptRunStore.getState().run(bundle.script)
      if (!current() || useScriptRunStore.getState().epoch !== epoch) return
      const result = useScriptRunStore.getState().byScript[bundle.script]
      if (result?.error) {
        setError(backendCodeMsg(result.error.code, result.error.params, result.error.message))
      } else if (result?.descriptors.length === 1) {
        await useRuntimeAssetStore.getState().loadAssets()
        if (!current() || useScriptRunStore.getState().epoch !== epoch) return
        const assetId = result.descriptors[0].asset_id
        if (addFigureToLayout(assetId) === 'missing') {
          setError(msg('fastEdit.figureMissing', { name: assetId }, 'workspace'))
        } else {
          onClose()
        }
      }
    } catch (e) {
      if (current()) setError(backendErrorMsg(e))
    } finally {
      if (current()) setBusy(false)
    }
  }

  const columns = inspection?.columns ?? []
  return <Dialog open onOpenChange={(value) => { if (!value) onClose() }}
    anchor="batfig-csv-import" title={t('csvImport.title')} description={t('csvImport.description')}
    busy={busy} footer={<Button data-csv-create onClick={() => void create()}
      disabled={busy || !inspection || !x || ys.length === 0} loading={busy}>{t('csvImport.create')}</Button>}>
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        {t('csvImport.file')}
        <TextInput data-csv-file type="file" accept=".csv,text/csv" disabled={busy}
          onChange={(e) => void choose(e.target.files?.[0])} />
      </label>
      {inspection && <>
        <p className="text-xs text-ink-2">{t('csvImport.rows', { count: inspection.row_count })}</p>
        <div data-csv-x>
          <Select ariaLabel={t('csvImport.x')} value={x} disabled={busy}
            onChange={(v) => { setX(v); setYs((old) => old.filter((y) => y !== v)); setXLabel(v) }}
            options={columns.filter((c) => c.numeric).map((c) => ({ value: c.name, label: c.name }))} />
        </div>
        <fieldset className="flex flex-wrap gap-3" disabled={busy}>
          <legend className="mb-1 text-sm">{t('csvImport.ys')}</legend>
          {columns.filter((c) => c.name !== x).map((c) => <label key={c.name} className="flex items-start gap-2 text-sm">
            <Checkbox data-csv-y={c.name} checked={ys.includes(c.name)} disabled={!c.numeric}
              onChange={(e) => setYs((old) => e.target.checked ? [...old, c.name] : old.filter((v) => v !== c.name))} />
            <span className="min-w-0 break-words">
              {c.name}
              {!c.numeric && c.error && <span data-csv-column-error={c.name} className="block text-xs text-danger">
                {c.error}
              </span>}
            </span>
          </label>)}
        </fieldset>
        <label className="flex flex-col gap-1 text-sm">{t('csvImport.xLabel')}
          <TextInput data-csv-x-label value={xLabel} disabled={busy} onChange={(e) => setXLabel(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">{t('csvImport.yLabel')}
          <TextInput data-csv-y-label value={yLabel} disabled={busy} onChange={(e) => setYLabel(e.target.value)} />
        </label>
        <p className="break-all text-xs text-ink-3">{t('csvImport.hash', { hash: inspection.sha256 })}</p>
      </>}
      {error && <p data-csv-error className="text-sm text-danger" role="alert">{formatMessage(error)}</p>}
    </div>
  </Dialog>
}
