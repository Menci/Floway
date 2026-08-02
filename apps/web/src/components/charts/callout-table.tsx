import type { ReactNode } from 'react';

import { SeriesMarker } from './series-marker';
import { fluentComponents } from '../../fluent';

const { Text } = fluentComponents;
// Header matches the axis labels' Caption size and the value rows sit under it,
// against the ramp's leadings — so neither pair is one WinUI's ramp states.
const headerTextStyle = { fontSize: '12px', lineHeight: '16px' } as const;
const bodyTextStyle = { fontSize: '11px', lineHeight: '14px' } as const;

export interface ChartCalloutColumn {
  key: string;
  label: ReactNode;
}

export interface ChartCalloutRow {
  color: string;
  key: string;
  label: ReactNode;
  values: ReactNode[];
}

export function ChartCalloutTable({ columns, rows, title }: { columns: ChartCalloutColumn[]; rows: ChartCalloutRow[]; title: ReactNode }) {
  return <table className="border-collapse leading-[1.15] whitespace-nowrap [&_td]:!py-0">
    <thead>
      <tr>
        <th className="max-w-[180px] min-w-[120px] pb-1 pl-0 text-left"><Text weight="semibold" className="text-fui-fg2" style={headerTextStyle}>{title}</Text></th>
        {columns.map(column => <th className="px-1.5 pb-1 text-right" key={column.key}><Text weight="semibold" className="text-fui-fg2" style={headerTextStyle}>{column.label}</Text></th>)}
      </tr>
    </thead>
    <tbody>
      {rows.map(row => <tr key={row.key}>
        <td className="max-w-[180px] min-w-[120px] pl-0 text-left">
          <span className="flex items-center gap-1.5 min-w-0 overflow-hidden text-ellipsis">
            <SeriesMarker color={row.color} />
            <Text style={bodyTextStyle}>{row.label}</Text>
          </span>
        </td>
        {row.values.map((value, index) => <td className="px-1.5 text-right tabular-nums" key={columns[index]!.key}><Text style={bodyTextStyle}>{value}</Text></td>)}
      </tr>)}
    </tbody>
  </table>;
}
