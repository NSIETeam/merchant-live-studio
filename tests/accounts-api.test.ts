import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/server/db.js";
import { createApp } from "../src/composition/studio.js";
import { loadConfig } from "../src/platform/infrastructure/public.js";
import { createAccessSecret } from "../src/platform/identity/credentials.js";

test("owner creates and resets scoped accounts once, manages access, and never rereads issued secrets",async()=>{
 const db=openDatabase(':memory:'),token=createAccessSecret();
 const app=createApp(db,loadConfig({DEMO_MODE:'false',MERCHANT_CREDENTIALS:JSON.stringify({owner:token,foreign:token})}));
 async function call(path:string,method='GET',body?:unknown,cookie=''){
  const r=await app.request('/api'+path,{method,headers:{cookie,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {status:r.status,data:await r.json() as any,cookie:r.headers.get('set-cookie')?.split(';')[0]||'',cache:r.headers.get('cache-control')};
 }
 try{
  const owner=(await call('/auth/merchant','POST',{merchantId:'owner',token})).cookie;
  const foreign=(await call('/auth/merchant','POST',{merchantId:'foreign',token})).cookie;
  const body={actorId:'new-member',role:'presenter',requestKey:crypto.randomUUID()};
  const pair=await Promise.all([call('/merchant/team/accounts','POST',body,owner),call('/merchant/team/accounts','POST',body,owner)]);
  const fresh=pair.find(r=>r.data.secret)!,replay=pair.find(r=>r.data.replayed)!;
  assert.equal(fresh.status,201);assert.equal(fresh.cache,'no-store');assert.equal(replay.status,200);assert.equal(replay.data.secret,undefined);
  assert.equal((await call('/merchant/team/accounts','POST',{...body,role:'editor'},owner)).status,409);
  const login=await call('/auth/merchant','POST',{merchantId:'new-member',token:fresh.data.secret});assert.equal(login.status,200);
  assert.equal((await call('/merchant/team/accounts','POST',{...body,actorId:'intruder',requestKey:crypto.randomUUID()},login.cookie)).status,403);
  const listed=(await call('/merchant/team','GET',undefined,owner)).data.members;
  assert.equal(listed.length,1);assert.equal(listed[0].managed,true);assert.equal(listed[0].credentialVersion,1);
  assert.equal(JSON.stringify(listed).includes(fresh.data.secret),false);
  const reset={expectedVersion:1,requestKey:crypto.randomUUID()};
  const path='/merchant/team/accounts/new-member/reset';
  assert.equal((await call(path,'POST',reset,foreign)).status,404);
  const rotated=await call(path,'POST',reset,owner);assert.equal(rotated.status,200);assert.equal(rotated.data.credentialVersion,2);
  assert.equal((await call(path,'POST',reset,owner)).data.secret,undefined);
  assert.equal((await call(path,'POST',{...reset,requestKey:crypto.randomUUID()},owner)).status,409);
  assert.equal((await call('/merchant/rooms','GET',undefined,login.cookie)).status,401);
  assert.equal((await call('/auth/merchant','POST',{merchantId:'new-member',token:fresh.data.secret})).status,401);
  assert.equal((await call('/auth/merchant','POST',{merchantId:'new-member',token:rotated.data.secret})).status,200);
  assert.equal((await call('/merchant/team/new-member','PUT',{disabled:true,version:0,reason:'测试停用新开户成员'},owner)).status,200);
  assert.equal((await call('/auth/merchant','POST',{merchantId:'new-member',token:rotated.data.secret})).status,401);
  for(const actorId of ['owner','foreign','demo'])assert.equal((await call('/merchant/team/accounts','POST',{...body,actorId,requestKey:crypto.randomUUID()},owner)).status,409);
  for(const actorId of ['__proto__','constructor','toString']) assert.equal((await call('/merchant/team/accounts','POST',{...body,actorId,requestKey:crypto.randomUUID()},owner)).status,400);
  assert.equal((await call('/merchant/team/accounts','POST',body)).status,401);
 }finally{db.close();}
});
