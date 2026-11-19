import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PanelGridSettings } from '@/lib/panelGrid'
import { Button } from '@/components/ui/Button'
import { Row, Section } from '@/components/ui/Field'
import { NumberField } from '@/components/ui/Input'
import { Segmented } from '@/components/ui/Segmented'
import { INSPECTOR_LABEL_W } from './layout'

interface PanelGridSectionProps {
  value: PanelGridSettings
  panelCount: number
  onApply: (settings: PanelGridSettings) => void
  disabled?: boolean
  scopeKey?: string
  status?: 'ready' | 'pending' | 'blocked' | 'invalid'
  message?: string
  onPrepare?: () => void
}

/** The document owns settings. Unsaved number inputs are scoped to this canvas/version. */
export function PanelGridSection(props: PanelGridSectionProps) {
  const { value } = props
  const version = JSON.stringify([
    props.scopeKey, value.cols, value.ratio, value.gap, value.margin, value.axisFontSizePt,
    value.basis, value.columnAlign, value.rowAlign, value.order,
  ])
  return <PanelGridControls key={version} {...props} />
}

function PanelGridControls({
  value, panelCount, onApply, disabled = false, status = 'ready', message, onPrepare,
}: PanelGridSectionProps) {
  const { t } = useTranslation('inspector')
  const [draft, setDraft] = useState(value)
  const latest = useRef(draft)
  const root = useRef<HTMLDivElement>(null)
  const unavailable = disabled || panelCount === 0
  const update = (patch: Partial<PanelGridSettings>) => {
    latest.current = { ...latest.current, ...patch }
    setDraft(latest.current)
  }
  const apply = (patch: Partial<PanelGridSettings> = {}) => {
    if (unavailable) return
    // A keyboard-triggered button can fire before the number field blurs. Flush
    // only this section's draft, then read the ref its synchronous callback set.
    const active = document.activeElement
    if (active instanceof HTMLInputElement && root.current?.contains(active)) active.blur()
    update(patch)
    onApply({ ...latest.current })
  }
  const ratios = [
    { label: '1:1', value: 1 }, { label: '4:3', value: 4 / 3 },
    { label: '3:2', value: 3 / 2 }, { label: '16:9', value: 16 / 9 },
  ]
  return (
    <Section title={t('panelGrid.title')} data-panel-grid>
      <div ref={root} className="flex min-w-0 flex-col gap-2">
        <p data-panel-grid-summary className="text-xs text-ink-3">
          {t('panelGrid.summary', { count: panelCount, rows: Math.ceil(panelCount / draft.cols), cols: draft.cols })}
        </p>
        <Button variant="primary" data-panel-grid-apply className="w-full" disabled={unavailable}
          onClick={() => apply()}>{t('panelGrid.apply')}</Button>
        <Row label={t('panelGrid.columns')} labelWidth={INSPECTOR_LABEL_W}>
          <NumberField fill dataProp="panel-grid-columns" ariaLabel={t('panelGrid.columns')}
            value={draft.cols} min={1} max={Math.max(1, panelCount)} step={1} precision={0}
            disabled={unavailable} onChange={(cols) => update({ cols: Math.round(cols) })} />
        </Row>
        <Row label={t('panelGrid.ratio')} labelWidth={INSPECTOR_LABEL_W}>
          <div data-panel-grid-ratios className="grid min-w-0 flex-1 grid-cols-4 gap-0.5">
            {ratios.map((ratio) => <Button key={ratio.label} size="sm" data-panel-grid-ratio={ratio.label}
              className="min-w-0 px-1" disabled={unavailable}
              active={Math.abs(draft.ratio - ratio.value) < 1e-9}
              aria-pressed={Math.abs(draft.ratio - ratio.value) < 1e-9}
              aria-label={t('panelGrid.ratioPreset', { ratio: ratio.label })}
              onClick={() => apply({ ratio: ratio.value })}>{ratio.label}</Button>)}
          </div>
        </Row>
        <p className="text-xs text-ink-3">{t('panelGrid.ratioHint')}</p>
        <Row label={t('panelGrid.axisFontSize')} labelWidth={INSPECTOR_LABEL_W}>
          <NumberField fill dataProp="panel-grid-axis-font-size" ariaLabel={t('panelGrid.axisFontSize')}
            value={draft.axisFontSizePt} min={1} step={0.5} precision={2} unit="pt" disabled={unavailable}
            onChange={(axisFontSizePt) => update({ axisFontSizePt })} />
        </Row>
        <p data-panel-grid-axis-font-hint className="text-xs text-ink-3">{t('panelGrid.axisFontHint')}</p>
        <Row label={t('panelGrid.gap')} labelWidth={INSPECTOR_LABEL_W}>
          <NumberField fill dataProp="panel-grid-gap" ariaLabel={t('panelGrid.gap')}
            value={draft.gap} min={0} step={0.5} precision={2} unit="mm" disabled={unavailable}
            onChange={(gap) => update({ gap })} />
        </Row>
        <div data-panel-grid-gaps className="grid grid-cols-4 gap-1">
          {[2, 3, 4, 6].map((gap) => <Button key={gap} size="sm" data-panel-grid-gap={gap}
            disabled={unavailable} active={draft.gap === gap} aria-pressed={draft.gap === gap}
            aria-label={t('panelGrid.gapPreset', { gap })}
            onClick={() => apply({ gap })}>{t('panelGrid.gapValue', { gap })}</Button>)}
        </div>
        <Row label={t('panelGrid.margin')} labelWidth={INSPECTOR_LABEL_W}>
          <NumberField fill dataProp="panel-grid-margin" ariaLabel={t('panelGrid.margin')}
            value={draft.margin} min={0} step={0.5} precision={2} unit="mm" disabled={unavailable}
            onChange={(margin) => update({ margin })} />
        </Row>
        <Row label={t('panelGrid.basis')} labelWidth={INSPECTOR_LABEL_W}>
          <Segmented data-testid="panel-grid-basis" ariaLabel={t('panelGrid.basis')}
            value={draft.basis} onChange={(basis) => apply({ basis })}
            items={[
              { value: 'axes', label: t('arrange.basisAxes'), disabled: unavailable },
              { value: 'image', label: t('arrange.basisImage'), disabled: unavailable },
            ]} />
        </Row>
        <Row label={t('panelGrid.columnAlign')} labelWidth={INSPECTOR_LABEL_W}>
          <Segmented data-testid="panel-grid-column-align" ariaLabel={t('panelGrid.columnAlign')}
            value={draft.columnAlign} onChange={(columnAlign) => apply({ columnAlign })}
            items={[
              { value: 'start', label: t('arrange.alignStartCol'), disabled: unavailable },
              { value: 'center', label: t('arrange.alignCenter'), disabled: unavailable },
              { value: 'end', label: t('arrange.alignEndCol'), disabled: unavailable },
            ]} />
        </Row>
        <Row label={t('panelGrid.rowAlign')} labelWidth={INSPECTOR_LABEL_W}>
          <Segmented data-testid="panel-grid-row-align" ariaLabel={t('panelGrid.rowAlign')}
            value={draft.rowAlign} onChange={(rowAlign) => apply({ rowAlign })}
            items={[
              { value: 'start', label: t('arrange.alignStartRow'), disabled: unavailable },
              { value: 'center', label: t('arrange.alignCenter'), disabled: unavailable },
              { value: 'end', label: t('arrange.alignEndRow'), disabled: unavailable },
            ]} />
        </Row>
        <p className="text-xs text-ink-3">{t('panelGrid.quickHint')}</p>
        {message && <p data-panel-grid-message className="text-xs text-ink-2">{message}</p>}
        {status === 'pending' && onPrepare && <Button data-panel-grid-prepare disabled={unavailable}
          onClick={onPrepare}>{t('arrange.readAxes')}</Button>}
      </div>
    </Section>
  )
}
