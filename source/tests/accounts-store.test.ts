import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.js";
import { createAccountStore } from "../src/platform/identity/persistence/accounts.js";
import { createAccessSecret, hashAccessSecret, verifyAccessSecret } from "../src/platform/identity/credentials.js";

test("managed credentials persist, reset with CAS, and keep atomic secret-free events", async () => {
  const folder = await mkdtemp(join(tmpdir(),"accounts-store-")), file=join(folder,"test.sqlite");
  let db = openDatabase(file);
  try {
    let store = createAccountStore(db);
    const first=createAccessSecret(), next=createAccessSecret();
    const verifier=await hashAccessSecret(first), replacement=await hashAccessSecret(next);
    const input={actor:"member",merchant:"owner",role:"presenter" as const,verifier,operator:"owner",request:"request-create",now:1};
    store.create(input);
    assert.throws(()=>store.create({...input,actor:"rollback-member"}));
    assert.equal(store.find("rollback-member"),undefined);
    assert.equal(store.list("foreign").length,0);
    assert.equal(JSON.stringify(store.list("owner")).includes(verifier),false);
    assert.equal(JSON.stringify(store.receipt("owner","request-create")).includes(verifier),false);
    assert.equal(store.receipt("foreign","request-create"),undefined);
    assert.throws(()=>store.reset({actor:"member",merchant:"foreign",expectedVersion:1,verifier:replacement,operator:"foreign",request:"bad",now:2}));
    const reset={actor:"member",merchant:"owner",expectedVersion:1,verifier:replacement,operator:"owner",request:"request-reset",now:2};
    assert.equal(store.reset(reset),2);
    assert.throws(()=>store.reset({...reset,request:"stale"}));
    assert.equal(store.receipt("owner","stale"),undefined);
    db.close();db=openDatabase(file);store=createAccountStore(db);
    const account=store.find("member")!;
    assert.equal(account.credential_version,2);
    assert.equal(await verifyAccessSecret(first,account.verifier),false);
    assert.equal(await verifyAccessSecret(next,account.verifier),true);
    assert.throws(()=>db.exec("DELETE FROM identity_account_events"));
    assert.throws(()=>db.exec("UPDATE identity_account_events SET performed_by='foreign'"));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM identity_account_events").get()!.n,2);
  } finally {db.close();await rm(folder,{recursive:true,force:true});}
});
