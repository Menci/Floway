// A column states its width once, on the column, so a header cell and the body
// cells beneath it cannot be sized apart -- the drift that a width written on
// one row's cells invites. Fluent's Table lays out `fixed`, where a column
// group's width is the track's width and a track without one shares what the
// sized tracks leave, so `null` is the column that absorbs the remainder.
// https://drafts.csswg.org/css-tables-3/#width-distribution-algorithm
export function TableColumns({ widths }: { widths: (string | null)[] }) {
  return <colgroup>
    {widths.map((width, index) => <col key={index} style={width === null ? undefined : { width }} />)}
  </colgroup>;
}
