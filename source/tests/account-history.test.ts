import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/server/db.js";
import { createApp } from "../src/composition/studio.js";
import { loadConfig } from "../src/platform/infrastructure/public.js";

test('account history pages all tenant events without credentials and restricts access',async()=>{
 const db=openDatabase(':memory:'),token='local-history-token-longer-than-32-characters';
 const app=createApp(db,loadConfig({DEMO_MODE:'false',MERCHANT_CREDENTIALS:JSON.stringify({owner:token,foreign:token,member:token}),MERCHANT_MEMBERSHIPS:JSON.stringify({member:{merchantId:'owner',role:'reviewer'}})}));
 try{
  const insert=db.prepare("INSERT INTO identity_account_events(merchant_id,actor_id,performed_by,kind,credential_version,request_key,request_fingerprint,created_at) VALUES(?,?,?,'reset',?,?,?,?)");
  for(let i=1;i<=107;i++)insert.run('owner','target','owner',i,'request-'+i,'private-fingerprint',i);
  insert.run('foreign','private-target','foreign',1,'foreign-key','private-fingerprint',108);
  const login=async(id:string)=>(await app.request('/api/auth/merchant',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({merchantId:id,token})})).headers.get('set-cookie')!.split(';')[0];
  const owner=await login('owner'),foreign=await login('foreign'),member=await login('member');
  const base='/api/merchant/team/accounts/events';
  const ids:number[]=[];let before:number|null=null;
  do{
   const res=await app.request(base+(before?`?before=${before}`:''),{headers:{cookie:owner}});
   assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');
   const page=await res.json() as any;
   for(const item of page.items){assert.deepEqual(Object.keys(item).sort(),['actorId','createdAt','credentialVersion','id','kind','targetActorId']);assert.equal(item.actorId,'owner');ids.push(item.id);}
   before=page.nextBefore;
  }while(before);
  assert.equal(ids.length,107);assert.equal(new Set(ids).size,107);
  const other=await (await app.request(base,{headers:{cookie:foreign}})).json() as any;assert.equal(other.items.length,1);
  assert.equal((await app.request(base,{headers:{cookie:member}})).status,403);
  assert.equal((await app.request(base)).status,401);
  assert.equal((await app.request(base+'?before=-1',{headers:{cookie:owner}})).status,400);
 }finally{db.close();}
});
