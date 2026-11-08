import { Archive, Clock3, Settings2, Stethoscope } from 'lucide-react'
import { useAppStore, type Route } from '../stores/app-store'
import { cn } from '../lib/utils'

const NAV: Array<{ id: Route; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'home', label: 'Extract', icon: Archive },
  { id: 'history', label: 'History', icon: Clock3 },
  { id: 'settings', label: 'Settings', icon: Settings2 },
  { id: 'diagnostics', label: 'Diagnostics', icon: Stethoscope }
]

/** Finder-style translucent sidebar. */
export function Sidebar(): React.JSX.Element {
  const route = useAppStore((s) => s.route)
  const setRoute = useAppStore((s) => s.setRoute)
  const history = useAppStore((s) => s.history)
  const interrupted = history.filter((j) => j.state === 'interrupted').length

  return (
    <nav
      aria-label="Primary"
      className="glass-subtle flex w-[190px] shrink-0 flex-col gap-0.5 border-r border-border/60 px-3 pb-3 pt-2"
    >
      {NAV.map(({ id, label, icon: Icon }) => {
        const active = route === id
        return (
          <button
            key={id}
            onClick={() => setRoute(id)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'ring-focus group flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] font-medium transition-colors',
              active ? 'bg-primary/15 text-primary' : 'text-secondary-foreground hover:bg-accent'
            )}
          >
            <Icon className={cn('size-[17px]', active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')} />
            <span className="flex-1 text-left">{label}</span>
            {id === 'history' && interrupted > 0 && (
              <span className="rounded-full bg-destructive/15 px-1.5 text-[10px] font-semibold text-destructive">
                {interrupted}
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )
}
