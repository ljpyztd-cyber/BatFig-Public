import { useTranslation } from 'react-i18next'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { useArrangeStore, type AlignBasis } from '@/store/arrangeStore'
import { prepareCanvasAlignment, useCanvasAlignment } from '@/store/canvasAlignment'

/** Shared alignment setting, shown in the inspector or the undocked floating bar. */
export function AlignBasisControl({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation('inspector')
  const basis = useArrangeStore((s) => s.alignBasis)
  const setBasis = useArrangeStore((s) => s.setAlignBasis)
  const geometry = useCanvasAlignment()
  const hint = geometry.pending ? t('arrange.axesSyncing') : t('arrange.basisHint')
  return (
    <div data-align-basis-control className="flex min-w-0 flex-col gap-1" title={hint}>
      <Select<AlignBasis>
        ariaLabel={t('arrange.basisLabel')}
        value={basis}
        onChange={setBasis}
        options={[
          { value: 'axes', label: t('arrange.basisAxes') },
          { value: 'image', label: t('arrange.basisImage') },
        ]}
        className="w-auto min-w-0 max-w-full"
      />
      {geometry.pending && (
        <Button size="sm" data-read-axes onClick={prepareCanvasAlignment}>{t('arrange.readAxes')}</Button>
      )}
      {!compact && <p className="text-xs text-ink-3">{hint}</p>}
    </div>
  )
}
