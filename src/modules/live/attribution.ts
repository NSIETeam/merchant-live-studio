import { transaction } from "../../platform/infrastructure/public.js";
import type { DB } from "../../shared/persistence.js";
import { recordSourceVisit, sourceViewingRows } from "./persistence/attribution-queries.js";
export function createSourceViewing(db: DB, valid: (code:string,room:string,now:number)=>boolean) {
 return {
  record(room:string,viewer:string,code:string|undefined,now:number) { transaction(db, () => { if(code && valid(code,room,now))recordSourceVisit(db,room,viewer,code,now); }); },
  metrics(codes:string[]) { const rows=[...new Set(codes)].flatMap(code=>sourceViewingRows(db,code)); return {sourceViewers:new Set(rows.map(r=>r.viewer_id)).size,watchSeconds:rows.reduce((sum,r)=>sum+Number(r.watchSeconds),0)}; }
 };
}
