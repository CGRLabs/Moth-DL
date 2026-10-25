/** Top bar: quick add, search, and live rate. */

import { IconChart, IconPlus, IconSearch } from './Icons.js'

interface Props {
  onAdd: () => void
  onVisualize: () => void
  search: string
  onSearch: (value: string) => void
  /** How many downloads match the current search, for the field's badge. */
  matchCount: number
  totalCount: number
  showSearch?: boolean
}

export function Header(props: Props): React.ReactElement {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-[color:var(--surface-2)] px-4">
      <button
        type="button"
        onClick={props.onAdd}
        title="Need to download something? Paste a link — we'll figure out the rest."
        className="btn-primary inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-[13px] font-semibold text-on-brand transition-transform active:scale-[0.98]"
      >
        <IconPlus size={14} />
        Download
      </button>

      <button
        type="button"
        onClick={props.onVisualize}
        title="Open the live download flow visualization"
        className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-line px-3 py-2 text-[11.5px] font-semibold text-ink-2 transition-colors hover:bg-[color:var(--surface-3)] hover:text-ink"
      >
        <IconChart size={14} />
        Flow
      </button>

      {props.showSearch !== false ? (
        <div className="relative ml-1 min-w-0 max-w-md flex-1">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted">
            <IconSearch size={13} />
          </span>
          <input
            value={props.search}
            onChange={(event) => props.onSearch(event.target.value)}
            placeholder="Search downloads"
            aria-label="Filter downloads"
            className="w-full rounded-lg border border-line bg-[color:var(--surface)] py-2 pl-8 pr-2 text-[13px] text-ink placeholder:text-muted focus:border-[color:var(--color-brand-500)] focus:outline-none"
          />
          {props.search.length > 0 ? (
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[10.5px] tabular-nums text-muted">
              {props.matchCount}/{props.totalCount}
            </span>
          ) : null}
        </div>
      ) : null}

    </header>
  )
}
