import { AccountHistory } from "./AccountHistory.js";
import { useState } from "react";
import { api } from "../shared/api.js";
import { memberRoleNames, type MemberRole } from "../../shared/membership.js";
type ManagedMember = { actorId: string; managed?: boolean; credentialVersion?: number };
type Issued = { actorId: string; credentialVersion: number; secret?: string; replayed: boolean };
export function AccountProvisioning({members,onChanged}:{members:ManagedMember[];onChanged:()=>Promise<void>}) {
 const [actor,setActor]=useState(""),[role,setRole]=useState<Exclude<MemberRole,"owner">>("presenter"),[target,setTarget]=useState(""),[confirmed,setConfirmed]=useState(false);
 const [request,setRequest]=useState(()=>crypto.randomUUID()),[busy,setBusy]=useState(false),[error,setError]=useState(""),[issued,setIssued]=useState<Issued|null>(null),[message,setMessage]=useState("");
 const change=()=>{setRequest(crypto.randomUUID());setMessage("");};
 async function submit(reset:boolean) {
  if(busy)return;
  const member=members.find(m=>m.actorId===target&&m.managed);
  if(reset&&(!member||!confirmed))return;
  setBusy(true);setError("");setMessage("");
  try {
   const value=reset?await api<Issued>(`/merchant/team/accounts/${encodeURIComponent(target)}/reset`,"POST",{expectedVersion:member!.credentialVersion,requestKey:request}):await api<Issued>("/merchant/team/accounts","POST",{actorId:actor,role,requestKey:request});
   if(value.secret)setIssued(value);
   setMessage(value.replayed?"此操作已完成。原密钥不会再次显示；如未保存，请刷新成员列表后重新重置。":reset?"新密钥已生成，旧密钥与旧会话已失效。":"账号已创建，请保存下方密钥并交给对应成员。");
   setConfirmed(false);
   await onChanged();
   setRequest(crypto.randomUUID());
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <details className="account-provisioning">
  <summary>新增成员与重置密钥</summary>
  <p>现有服务器配置账号继续保留；此处可创建普通成员并管理其密钥，不提供实名核验。</p>
  {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
  {issued?.secret&&<aside className="notice" aria-label="一次性访问密钥">
   <strong>{issued.actorId} 的访问密钥</strong>
   <p>仅在本次操作后显示。请妥善保存；关闭或刷新页面后不可重新读取。</p>
   <textarea readOnly value={issued.secret} aria-label="新访问密钥" autoComplete="off" spellCheck={false}/>
   <button type="button" onClick={()=>{setIssued(null);setMessage("密钥已隐藏。如未保存，可重新重置；列表不能取回原密钥。");}}>已保存，隐藏密钥</button>
  </aside>}
  <form onSubmit={e=>{e.preventDefault();void submit(false);}}>
   <label>新成员账号<input required pattern="[a-zA-Z0-9_-]{1,50}" maxLength={50} value={actor} autoComplete="off" disabled={busy} onChange={e=>{setActor(e.target.value);change();}}/></label>
   <label>初始角色<select value={role} disabled={busy} onChange={e=>{setRole(e.target.value as typeof role);change();}}>{Object.entries(memberRoleNames).filter(([key])=>key!=="owner").map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
   <button disabled={busy||!actor.trim()}>{busy?"处理中…":"创建成员"}</button>
  </form>
  <form onSubmit={e=>{e.preventDefault();void submit(true);}}>
   <label>需要重置的成员<select value={target} disabled={busy} onChange={e=>{setTarget(e.target.value);setConfirmed(false);change();}}><option value="">选择成员</option>{members.filter(m=>m.managed).map(m=><option key={m.actorId} value={m.actorId}>{m.actorId}</option>)}</select></label>
   <label className="account-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>{setConfirmed(e.target.checked);change();}}/>我确认重置该成员的密钥，并使其旧登录失效</label>
   <button disabled={busy||!target||!confirmed}>重置访问密钥</button>
  </form>
  <AccountHistory />
 </details>;
}
