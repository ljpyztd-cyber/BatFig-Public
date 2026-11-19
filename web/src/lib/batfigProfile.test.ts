import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE_ID, loadProfile } from './profile'
import { runSpec, type PreflightSpec } from './preflight'
import type { Manifest } from './api'
import { bindingFor, builtinCatalog, resolveDocumentSpec } from './specBinding'

const ARIAL_FACES = ['Arial', 'ArialMT', 'Arial-BoldMT', 'Arial-ItalicMT', 'Arial-BoldItalicMT']
const TIMES_FACES = ['Times New Roman', 'TimesNewRomanPSMT', 'TimesNewRomanPS-BoldMT', 'TimesNewRomanPS-ItalicMT', 'TimesNewRomanPS-BoldItalicMT']

function specOf(family: string): PreflightSpec {
  const manifest = {
    stem: 'Font probe', size_mm: [95.25, 76.2], elements: [{
      gid: 'axes_0.xlabel', role: 'axis_label', bbox: [0.1, 0.1, 0.2, 0.1],
      editable: [
        { prop: 'fontfamily', value: family },
        { prop: 'fontsize', value: 8 },
        { prop: 'text', value: 'Distance (nm)' },
      ],
    }],
  } as unknown as Manifest
  return {
    page: { w_mm: 95.25, h_mm: 76.2, margin_mm: 0 },
    panels: [{ id: 'figure', name: 'Font probe', kind: 'pdf',
      rect_mm: [0, 0, 95.25, 76.2], scale: 1, manifest, px_w: null,
      missing: false, stale: false, render_error: null, unapplied_overrides: 0, hidden: false }],
    texts: [], objects: [],
  }
}

describe('BatFig Arial default', () => {
  it('makes Arial the default while retaining explicit upstream profiles', () => {
    expect(DEFAULT_PROFILE_ID).toBe('batfig-arial-v1')
    expect(loadProfile().font_family.latin).toBe('Arial')
    expect(loadProfile('lab-publication-v1').font_family.latin).toBe('Times New Roman')
  })

  it.each([...ARIAL_FACES, ...TIMES_FACES])('accepts the exact family/face %s', (family) => {
    const findings = runSpec(specOf(family), loadProfile()).filter(i => i.id === 'font-family-substituted')
    expect(findings).toHaveLength(0)
  })

  it.each(['Times', 'Liberation Serif', 'Liberation Sans', 'Helvetica'])('rejects the substitute %s', (family) => {
    const findings = runSpec(specOf(family), loadProfile()).filter(i => i.id === 'font-family-substituted')
    expect(findings.map(i => i.severity)).toEqual(['error'])
  })

  it('retains an Arial-only saved snapshot until explicitly synchronized to the current built-in profile', () => {
    const entry = builtinCatalog().find((item) => item.id === DEFAULT_PROFILE_ID)!
    const binding = bindingFor(entry)
    binding.snapshot = structuredClone(entry.data)
    const savedFamily = binding.snapshot.font_family as Record<string, unknown>
    savedFamily.latin_accepted = [...ARIAL_FACES]
    const resolved = resolveDocumentSpec(binding, [entry])
    expect(resolved.source).toBe('snapshot')
    expect(resolved.updateAvailable).toBe(true)
    expect(runSpec(specOf('Times New Roman'), resolved.profile).filter(i => i.id === 'font-family-substituted').map(i => i.severity)).toEqual(['error'])
    const synced = resolveDocumentSpec(bindingFor(entry), [entry])
    expect(synced.updateAvailable).toBe(false)
    expect(runSpec(specOf('Times New Roman'), synced.profile).filter(i => i.id === 'font-family-substituted')).toHaveLength(0)
    expect(savedFamily.latin_accepted).toEqual(ARIAL_FACES)
  })
})
