interface Props {
  bitmap: number[]
  total: number
  active: boolean
}

/** Bounded heat map of ranges that have been durably completed. */
export function ChunkMap({ bitmap, total, active }: Props): React.ReactElement {
  if (total === 0) return <div className="bar" />

  const columns = Math.min(total, 120)
  const perColumn = Math.ceil(total / columns)
  const cells: number[] = []
  for (let column = 0; column < columns; column += 1) {
    const from = column * perColumn
    const to = Math.min(total, from + perColumn)
    let filled = 0
    for (let index = from; index < to; index += 1) filled += bitmap[index] ?? 0
    cells.push(to > from ? filled / (to - from) : 0)
  }

  return (
    <div
      className="chunk-strip"
      role="img"
      aria-label={`${bitmap.filter((value) => value === 1).length} of ${total} ranges durably completed`}
      title={`${bitmap.filter((value) => value === 1).length} of ${total} ranges durably completed`}
    >
      {cells.map((fill, index) => (
        <div
          key={index}
          className="chunk-cell"
          style={{
            backgroundColor:
              fill > 0
                ? `color-mix(in oklch, var(--color-brand-${active ? 500 : 400}) ${Math.round(fill * 100)}%, var(--chunk-idle))`
                : 'transparent'
          }}
        />
      ))}
    </div>
  )
}
