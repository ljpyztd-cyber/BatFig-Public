import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { ColorField, NumberField } from '@/components/ui/Input'
import { COLOR_PALETTES } from '@/lib/colorPalettes'
import {
  colorPositions, customColormapGradient, isCustomColormap, MAX_COLOR_STOPS,
  MIN_COLOR_STOPS, type ColormapValue, type CustomColormap,
} from '@/lib/customColormap'

/** Local draft only. The complete color scale is one undoable edit on Apply. */
export function CustomColormapEditor({ value, onApply, onClose }: {
  value: ColormapValue | null
  onApply: (value: CustomColormap) => void
  onClose: () => void
}) {
  const { t } = useTranslation('inspector')
  const { t: common } = useTranslation('common')
  const [map, setMap] = useState<CustomColormap>(() => isCustomColormap(value)
    ? { type: 'custom', colors: [...value.colors], positions: [...colorPositions(value)] }
    : { type: 'custom', colors: ['#2166ac', '#f7f7f7', '#b2182b'], positions: [0, 0.5, 1] })
  const positions = colorPositions(map)
  const [error, setError] = useState(false)
  const [stopRevision, setStopRevision] = useState(0)
  const update = (colors: string[], nextPositions = positions, replaceStops = true) => {
    if (replaceStops) setStopRevision((revision) => revision + 1)
    setMap({ type: 'custom', colors, positions: nextPositions })
    setError(false)
  }
  const addStop = () => {
    // Split the widest interval so repeated additions never create duplicate positions.
    let at = 1
    for (let i = 2; i < positions.length; i++)
      if (positions[i] - positions[i - 1] > positions[at] - positions[at - 1]) at = i
    const colors = [...map.colors]
    const next = [...positions]
    const a = map.colors[at - 1], b = map.colors[at]
    const rgb = [1, 3, 5].map((start) => Math.round((parseInt(a.slice(start, start + 2), 16) +
      parseInt(b.slice(start, start + 2), 16)) / 2).toString(16).padStart(2, '0')).join('')
    colors.splice(at, 0, `#${rgb}`)
    next.splice(at, 0, (positions[at - 1] + positions[at]) / 2)
    update(colors, next)
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}
      anchor="custom-colormap" size="lg" title={t('control.diyTitle')}
      description={t('control.diyHint')}
      footer={<>
        <Button onClick={onClose}>{common('actions.cancel')}</Button>
        <Button variant="primary" data-cmap-apply onClick={() => {
          if (!isCustomColormap(map)) { setError(true); return }
          onApply(map)
        }}>{t('control.diyApply')}</Button>
      </>}
    >
      <div className="flex flex-col gap-3">
        <div data-cmap-draft-gradient className="h-7 w-full rounded-sm border border-border"
          style={{ background: customColormapGradient(map) }} />
        <div className="flex flex-wrap gap-1">
          {COLOR_PALETTES.filter((palette) => palette.kind === 'diverging').map((palette) => <Button key={palette.id} variant="secondary"
            data-cmap-preset={palette.id} onClick={() => update([...palette.colors],
              palette.colors.map((_, i) => i / (palette.colors.length - 1)))}>
            <span aria-hidden className="h-3 w-10 rounded-xs"
              style={{ background: `linear-gradient(to right, ${palette.colors.join(',')})` }} />
            {common(palette.nameKey)}
          </Button>)}
        </div>
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
          {map.colors.map((color, i) => <div key={i} data-cmap-stop={i} className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-sm text-ink-2">{t('control.diyStop', { index: i + 1 })}</span>
            <div className="min-w-0 flex-1"><ColorField ariaLabel={t('control.diyColor', { index: i + 1 })}
              scopeKey={`${stopRevision}:${i}`} value={color}
              onChange={(v) => update(map.colors.map((c, j) => j === i ? v : c), positions, false)} /></div>
            <NumberField ariaLabel={t('control.diyPosition', { index: i + 1 })} unit="%"
              value={positions[i] * 100} min={0} max={100} step={1} precision={2}
              disabled={i === 0 || i === map.colors.length - 1}
              onChange={(v) => update([...map.colors], positions.map((p, j) => j === i ? v / 100 : p))} />
            <Button data-cmap-remove={i} disabled={map.colors.length <= MIN_COLOR_STOPS || i === 0 || i === map.colors.length - 1}
              aria-label={t('control.diyRemove', { index: i + 1 })}
              onClick={() => update(map.colors.filter((_, j) => j !== i), positions.filter((_, j) => j !== i))}>
              {t('control.diyRemoveLabel')}
            </Button>
          </div>)}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" data-cmap-add disabled={map.colors.length >= MAX_COLOR_STOPS}
            onClick={addStop}>{t('control.diyAdd')}</Button>
          <Button variant="secondary" data-cmap-reverse onClick={() => update([...map.colors].reverse(),
            [...positions].reverse().map((p) => 1 - p))}>{t('control.diyReverse')}</Button>
          <Button variant="secondary" onClick={() => update([...map.colors],
            map.colors.map((_, i) => i / (map.colors.length - 1)))}>{t('control.diyEven')}</Button>
        </div>
        {error && <p data-cmap-error className="text-sm text-danger">{t('control.diyInvalid')}</p>}
      </div>
    </Dialog>
  )
}
