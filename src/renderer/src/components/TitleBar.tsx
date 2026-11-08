import { PackageOpen } from 'lucide-react'

/**
 * Titlebar for hiddenInset traffic lights: a drag region that leaves the
 * system buttons clickable (they sit outside the web view), with the app
 * identity inline like Finder's toolbar.
 */
export function TitleBar(): React.JSX.Element {
  return (
    <header className="titlebar-drag flex h-[52px] shrink-0 items-center gap-2.5 px-[88px]">
      <div className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
        <PackageOpen className="size-[18px] text-primary" strokeWidth={2.2} />
        Unbox
      </div>
      <span className="text-xs text-muted-foreground">universal extractor</span>
    </header>
  )
}
