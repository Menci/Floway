import type { ReactNode } from 'react';

import { SeriesMarker } from './series-marker';
import { fluentComponents } from '../../fluent';

const { Text } = fluentComponents;
// The header takes Caption, the size the axis labels beside it are set in. The
// value rows sit one step under it, off the ramp: the operator ruled this size
// himself, trying 12 and 11.5 and settling back on 11. The leadings are his
// too -- he asked for the size to move and the leading to stay -- so they are
// not the pairs the ramp states.
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
        {row.values.map((value, index) => <td className="px-1.5 text-right" key={columns[index]!.key}><Text style={bodyTextStyle}>{value}</Text></td>)}
      </tr>)}
    </tbody>
  </table>;
}
