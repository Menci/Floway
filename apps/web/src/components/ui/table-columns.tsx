// A column states its width once, on the column, so a header cell and the body
// cells beneath it cannot be sized apart -- the drift that a width written on
// one row's cells invites. Fluent's Table root already lays out `fixed` at full
// width, so a call site states neither; under that layout a column group's
// width is the track's width and a track without one shares what the sized
// tracks leave, which makes `null` the column that absorbs the remainder.
// https://github.com/microsoft/fluentui/blob/c771f587c6634a356605e6d7d4658681f15d689b/packages/react-components/react-table/library/src/components/Table/useTableStyles.styles.ts#L13-L20
// https://drafts.csswg.org/css-tables-3/#width-distribution-algorithm
export function TableColumns({ widths }: { widths: (string | null)[] }) {
  return <colgroup>
    {widths.map((width, index) => <col key={index} style={width === null ? undefined : { width }} />)}
  </colgroup>;
}
