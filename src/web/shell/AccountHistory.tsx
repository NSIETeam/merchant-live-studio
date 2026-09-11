import { useState } from "react";
import { api } from "../shared/api.js";
type Page = { items: { id:number; targetActorId:string; actorId:string; kind:"create"|"reset"; credentialVersion:number; createdAt:number }[]; nextBefore:number|null };
export function AccountHistory() {
 const [page,setPage]=useState<Page|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
 async function load(append=false) {
  if(busy)return;setBusy(true);setError("");
  try{const next=await api<Page>('/merchant/team/accounts/events'+(append&&page?.nextBefore?`?before=${page.nextBefore}`:''));setPage(old=>({...next,items:append&&old?[...old.items,...next.items]:next.items}));}
  catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <details onToggle={e=>{if(e.currentTarget.open&&!page&&!busy)void load();}}>
  <summary>开户与密钥重置历史</summary>
  {error&&<p role="alert">{error}</p>}
  <button disabled={busy} onClick={()=>void load()}>{busy?'正在读取…':'刷新账号操作历史'}</button>
  {page?.items.length===0&&<p>暂无开户或密钥重置记录。</p>}
  {page?.items.map(item=><article className="card" key={item.id}>
   <strong>{item.kind==='create'?'创建账号':'重置密钥'} · {item.targetActorId}</strong>
   <p>{new Date(item.createdAt).toLocaleString()} · 操作人：{item.actorId} · 凭据版本 {item.credentialVersion}</p>
  </article>)}
  {page?.nextBefore&&<button disabled={busy} onClick={()=>void load(true)}>更早账号操作</button>}
 </details>;
}
