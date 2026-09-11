/** Bootstrap-only connection contract. Module APIs never return this handle. */
export type SQLValue = string | number | bigint | null | Uint8Array;
export interface DB {
  prepare(sql: string): {
    get(...values: SQLValue[]): Record<string, SQLValue> | undefined;
    all(...values: SQLValue[]): Record<string, SQLValue>[];
    run(...values: SQLValue[]): {
      changes: number | bigint;
      lastInsertRowid: number | bigint;
    };
  };
  exec(sql: string): void;
  close(): void;
  readonly isTransaction: boolean;
}
