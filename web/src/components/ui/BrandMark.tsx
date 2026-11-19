import type { SVGProps } from 'react'

/** BatFig 原型自己的坐标轴/曲线标识，不使用上游图标。 */
type Tone = 'default' | 'paper' | 'reverse' | 'mono'

export interface BrandMarkProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  size: number
  tone?: Tone
  title?: string
}

export function BrandMark({ size, tone = 'default', title, ...props }: BrandMarkProps) {
  const ink = tone === 'reverse' ? 'var(--color-bg)' : 'currentColor'
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className="shrink-0"
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
      {...props}
    >
      <path d="M4 3V20H22M7 15L11 8L16 11L21 4" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
