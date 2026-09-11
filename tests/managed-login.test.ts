import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/server/db.js";
import { createApp } from "../src/composition/studio.js";
import { loadConfig } from "../src/platform/infrastructure/public.js";
import { createAccountStore } from "../src/platform/identity/persistence/accounts.js";
import { createAccessSecret, hashAccessSecret } from "../src/platform/identity/credentials.js";

test("managed login uses scoped role, revokes old sessions after reset and keeps configured owner login", async () => {
 const db=openDatabase(":memory:");
 const ownerToken=createAccessSecret(), first=createAccessSecret(), next=createAccessSecret();
 const config=loadConfig({DEMO_MODE:"false",MERCHANT_CREDENTIALS:JSON.stringify({owner:ownerToken})});
 const store=createAccountStore(db);
 try {
  store.create({actor:"member",merchant:"owner",role:"presenter",verifier:await hashAccessSecret(first),operator:"owner",request:"create",now:1});
  const app=createApp(db,config);
  const login=(id:string,token:string)=>app.request('/api/auth/merchant',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({merchantId:id,token})});
  const original=await login("member",first);assert.equal(original.status,200);
  const identity=await original.json() as any;assert.equal(identity.merchantId,"owner");assert.equal(identity.memberRole,"presenter");assert.equal(identity.requiresIndependentReview,true);
  const cookie=original.headers.get('set-cookie')!.split(';')[0];
  const read=()=>app.request('/api/merchant/rooms',{headers:{cookie}});
  assert.equal((await read()).status,200);
  assert.equal((await app.request('/api/merchant/team',{headers:{cookie}})).status,403);
  store.reset({actor:"member",merchant:"owner",expectedVersion:1,verifier:await hashAccessSecret(next),operator:"owner",request:"reset",now:2});
  assert.equal((await read()).status,401);
  assert.equal((await login("member",first)).status,401);
  assert.equal((await login("member",next)).status,200);
  assert.equal((await login("owner",ownerToken)).status,200);
  delete config.merchantCredentials.owner;
  assert.equal((await login("member",next)).status,401);
 }finally{db.close();}
});
