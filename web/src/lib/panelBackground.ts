import type { PanelOverride } from '@/types/document'

/** Only new editable panels get these defaults. Saved documents keep their own appearance. */
export function newPanelOverrides(editable: boolean, baked: readonly PanelOverride[] = []): PanelOverride[] {
  const overrides = structuredClone([...baked])
  if (!editable) return overrides
  for (const prop of ['transparent', 'axes_transparent']) {
    if (!overrides.some((p) => p.gid === 'figure' && p.prop === prop))
      overrides.push({ gid: 'figure', prop, value: true })
  }
  return overrides
}
