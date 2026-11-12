import type { ReactNode } from 'react';

export interface Column<T> {
  readonly key: string;
  readonly header: ReactNode;
  readonly render: (row: T) => ReactNode;
  readonly align?: 'left' | 'right';
  /** The cell that names the row: a row header (`th scope="row"`) for screen readers. */
  readonly rowHeader?: boolean;
}

/**
 * A data table with a caption (its accessible name). It scrolls sideways inside its own box, never
 * the page. Without rows it shows `empty` instead of an empty table.
 */
export function Table<T>({
  caption,
  captionHidden,
  columns,
  rows,
  rowKey,
  empty,
}: {
  caption: string;
  captionHidden?: boolean;
  columns: ReadonlyArray<Column<T>>;
  rows: readonly T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
}) {
  if (rows.length === 0 && empty !== undefined) return <>{empty}</>;
  const cls = (c: Column<T>) => (c.align === 'right' ? 'ui-r' : undefined);
  return (
    <div className="ui-tbl-wrap">
      <table className="ui-tbl">
        <caption className={captionHidden ? 'ui-sr' : undefined}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cls(c)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)}>
              {columns.map((c) =>
                c.rowHeader ? (
                  <th key={c.key} scope="row" className={cls(c)}>
                    {c.render(r)}
                  </th>
                ) : (
                  <td key={c.key} className={cls(c)}>
                    {c.render(r)}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
