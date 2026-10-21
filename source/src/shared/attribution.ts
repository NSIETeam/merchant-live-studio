export interface Store {
  id: string;
  name: string;
  externalRef: string;
  createdAt: number;
}
export interface SourceLink {
  code: string;
  storeId: string;
  roomId: string;
  label: string;
  createdAt: number;
  disabledAt: number | null;
}
export type OfflineKind = "visit" | "order" | "cost";
export interface OfflineInput {
  kind: OfflineKind;
  externalId: string;
  occurredAt: string;
  amountYuan: string;
  sourceCode?: string;
  customerRef?: string;
  previousVersion?: number;
  voided?: boolean;
  note?: string;
}
export type SourceMatch =
  | "linked_source"
  | "missing_source"
  | "unknown_source"
  | "store_mismatch"
  | "outside_source_period";
export interface OfflineRecord {
  id: string;
  storeId: string;
  kind: OfflineKind;
  externalId: string;
  revision: number;
  sourceCode: string;
  linkedSourceCode: string | null;
  matchState: SourceMatch;
  customerRef: string;
  occurredAt: number;
  amountCents: number;
  voided: number;
  note: string;
  actorId: string;
  createdAt: number;
  batchId: string;
}
export interface ImportPreview {
  canImport: boolean;
  rows: {
    index: number;
    kind: OfflineKind;
    amountCents: number;
    occurredAt: number;
    externalId: string;
    action: "new" | "correction" | "duplicate" | "conflict";
    message: string;
    matchState: SourceMatch;
  }[];
}
export interface StoreMetrics {
  storeId: string;
  name: string;
  sourceViewers: number;
  watchSeconds: number;
  visits: number;
  orders: number;
  salesCents: number;
  costCents: number;
  unlinkedRecords: number;
  unlinkedSalesCents: number;
}
