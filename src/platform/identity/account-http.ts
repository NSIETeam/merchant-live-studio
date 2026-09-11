import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { Config } from "../infrastructure/public.js";
import type { createAccountStore } from "./persistence/accounts.js";
import { createAccessSecret, hashAccessSecret } from "./credentials.js";
export function attachAccountManagement(app: Hono<{Variables:{merchantId:string;viewerId:string}}>, config:Config, store:ReturnType<typeof createAccountStore>) {
  let active=0;
  const pending=new Map<string,Promise<void>>();
  const identifier=z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/).refine(id=>!Object.hasOwn(Object.prototype,id), '账号编号不可用');
  async function execute(merchant:string, operator:string, input:{actorId:string;requestKey:string;role?:"editor"|"reviewer"|"presenter"|"analyst";expectedVersion?:number}, kind:"create"|"reset") {
    const key=merchant+":"+input.requestKey;
    const ongoing=pending.get(key);if(ongoing)await ongoing.catch(()=>{});
    const fingerprint=createHash("sha256").update(JSON.stringify([kind,input.actorId,input.role??null,input.expectedVersion??null])).digest("hex");
    const receipt=store.receipt(merchant,input.requestKey);
    if(receipt){
      if(receipt.request_fingerprint!==fingerprint||receipt.performed_by!==operator)throw new HTTPException(409,{message:"提交编号已用于其他账号操作"});
      return {actorId:receipt.actor_id,credentialVersion:receipt.credential_version,replayed:true};
    }
    if(input.actorId===operator||input.actorId===merchant||input.actorId==='demo'||Object.hasOwn(config.merchantCredentials,input.actorId)||Object.hasOwn(config.merchantMemberships||{},input.actorId))throw new HTTPException(409,{message:"该账号由服务器配置管理，不能在此创建或重置"});
    const account=store.find(input.actorId);
    if(kind==='create'&&account)throw new HTTPException(409,{message:"账号编号不可用"});
    if(kind==='reset'&&(!account||account.merchant_id!==merchant))throw new HTTPException(404);
    if(kind==='reset'&&account?.credential_version!==input.expectedVersion)throw new HTTPException(409,{message:"密钥版本已变化，请刷新后重试"});
    if(active>=4)throw new HTTPException(429,{message:"账号操作繁忙，请稍后重试"});
    active++;
    let release!:()=>void;
    pending.set(key,new Promise<void>(resolve=>{release=resolve;}));
    try {
      const secret=createAccessSecret(),verifier=await hashAccessSecret(secret);
      let version:number;
      try {
        version=kind==='create'?store.create({actor:input.actorId,merchant,role:input.role!,verifier,operator,request:input.requestKey,fingerprint,now:Date.now()}):store.reset({actor:input.actorId,merchant,expectedVersion:input.expectedVersion!,verifier,operator,request:input.requestKey,fingerprint,now:Date.now()});
      } catch {throw new HTTPException(409,{message:"账号状态已变化，请刷新列表后重试"});}
      return {actorId:input.actorId,credentialVersion:version,secret,replayed:false};
    }finally{active--;pending.delete(key);release();}
  }
  app.get('/api/merchant/team/accounts/events',c=>{
    const before=z.coerce.number().int().positive().safe().parse(c.req.query('before') || Number.MAX_SAFE_INTEGER);
    const rows=store.history(c.get('merchantId'),before);
    c.header('Cache-Control','no-store');
    return c.json({items:rows.slice(0,50),nextBefore:rows.length>50?rows[49].id:null});
  });
  app.post('/api/merchant/team/accounts',async c=>{
    const input=z.object({actorId:identifier,role:z.enum(['editor','reviewer','presenter','analyst']),requestKey:z.string().uuid()}).strict().parse(await c.req.json());
    const result=await execute(c.get('merchantId'),c.get('actorId'),input,'create');
    c.header('Cache-Control','no-store');return c.json(result,result.replayed?200:201);
  });
  app.post('/api/merchant/team/accounts/:actorId/reset',async c=>{
    const body=z.object({expectedVersion:z.number().int().positive().safe(),requestKey:z.string().uuid()}).strict().parse(await c.req.json());
    const result=await execute(c.get('merchantId'),c.get('actorId'),{...body,actorId:identifier.parse(c.req.param('actorId'))},'reset');
    c.header('Cache-Control','no-store');return c.json(result);
  });
}
