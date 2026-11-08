import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@renderer/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary/15 text-primary',
        neutral: 'border-border bg-secondary text-secondary-foreground',
        success: 'border-transparent bg-[var(--color-success)]/15 text-[var(--color-success)]',
        warning: 'border-transparent bg-[var(--color-warning)]/15 text-[var(--color-warning)]',
        destructive: 'border-transparent bg-destructive/12 text-destructive',
        outline: 'border-border text-foreground'
      }
    },
    defaultVariants: { variant: 'default' }
  }
)

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
