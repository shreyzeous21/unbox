import * as React from 'react'
import { cn } from '@renderer/lib/utils'

/**
 * Native-feeling progress components.
 * Linear: macOS-style rounded track with animated fill.
 * Ring: large circular indicator for the extraction screen.
 */

export function ProgressLinear({
  value,
  indeterminate = false,
  className
}: {
  value?: number
  indeterminate?: boolean
  className?: string
}) {
  const pct = value !== undefined ? Math.max(0, Math.min(100, value)) : undefined
  return (
    <div
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : pct}
      aria-valuemin={indeterminate ? undefined : 0}
      aria-valuemax={indeterminate ? undefined : 100}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-secondary', className)}
    >
      {indeterminate ? (
        <div className="progress-indeterminate h-full w-1/3 rounded-full bg-primary" />
      ) : (
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
          style={{ width: `${pct ?? 0}%` }}
        />
      )}
    </div>
  )
}

export function ProgressRing({
  value,
  indeterminate = false,
  size = 148,
  strokeWidth = 9,
  children
}: {
  value?: number
  indeterminate?: boolean
  size?: number
  strokeWidth?: number
  children?: React.ReactNode
}) {
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const pct = value !== undefined ? Math.max(0, Math.min(100, value)) : undefined
  const offset = pct !== undefined ? circumference * (1 - pct / 100) : indeterminate ? circumference * 0.75 : circumference

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" role="progressbar" aria-valuenow={pct ?? undefined}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          className="stroke-secondary"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={cn('stroke-primary transition-[stroke-dashoffset] duration-300 ease-out', indeterminate && 'progress-ring-spin')}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  )
}
