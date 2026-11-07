import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createWorker} from '../worker.mjs';
import {service,initialize} from '../service.mjs';
import {seal,unseal} from '../crypto.mjs';

// Executes the actual SQL against SQLite, including RETURNING and transactions.
// This adapter is not a Cloudflare runtime emulator; deployment dry-run and live
// account checks are separate validation steps.
class D1 {
  constructor(db=new DatabaseSync(':memory:')){this.db=db;}
  async exec(sql){this.db.exec(sql);return {count:1,duration:0};}
  prepare(sql){const db=this.db;let args=[];return {
    bind(...values){args=values;return this;},
    async first(){return db.prepare(sql).get(...args)||null;},
    async all(){return {success:true,results:db.prepare(sql).all(...args),meta:{changes:0}};},
    async run(){const r=db.prepare(sql).run(...args);return {success:true,results:[],meta:{changes:Number(r.changes)}};},
    execute(){const statement=db.prepare(sql);if(statement.columns().length){const results=statement.all(...args);return {success:true,results,meta:{changes:Number(db.prepare('SELECT changes() n').get().n)}};}const r=statement.run(...args);return {success:true,results:[],meta:{changes:Number(r.changes)}};}
  };}
  async batch(statements){this.db.exec('BEGIN IMMEDIATE');try{const result=statements.map(s=>s.execute());this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
}
const origin='https://tesla-delivery.example.workers.dev';
async function fixture(t) {
  const DB=new D1();await initialize(DB);t.after(()=>DB.db.close());
  const env={DB,APP_PASSWORD:'random-long-private-password',DATA_KEY:'ab'.repeat(32),PUBLIC_URL:origin,TESLA_CLIENT_ID:'client',TESLA_CLIENT_SECRET:'server-secret'};
  let data={response:[{referenceNumber:'RN123',modelCode:'MY',orderStatus:'ORDERED',vin:''}]},status=200,expires=3600,calls=[],hold=null;
  const fetcher=async(url,options)=>{
    calls.push({url,options});
    if(url.includes('/token')) {
      if(hold)await hold.promise;
      if(options.body.get('grant_type')==='client_credentials')return Response.json({access_token:'partner-private-token'});
      return Response.json({access_token:'access-private-token',refresh_token:'refresh-private-'+calls.length,expires_in:expires});
    }
    if(url.endsWith('/partner_accounts'))return Response.json({response:{ok:true}});
    return new Response(JSON.stringify(status===200?data:{error:'private details must never be exposed'}),{status,headers:status===429?{'retry-after':'3600'}:{}});
  };
  const worker=createWorker(fetcher),app=()=>service(env,fetcher);let cookie='';
  const req=(path,method='GET',body,headers={})=>worker.fetch(new Request(origin+path,{method,headers:{cookie,...(method==='POST'?{origin,'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)}),env);
  const login=async()=>{const r=await req('/api/login','POST',{password:env.APP_PASSWORD});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];return r;};
  const begin=async()=>{const r=await req('/auth/tesla');assert.equal(r.status,302);return new URL(r.headers.get('location')).searchParams.get('state');};
  const authorize=async()=>{await login();const state=await begin();const r=await req('/auth/callback?state='+state+'&code=test-code');assert.equal(r.status,302);return state;};
  return {env,DB,worker,app,req,login,begin,authorize,calls,setData:v=>data=v,setStatus:v=>status=v,setExpires:v=>expires=v,
    blockTokens:()=>{let resolve;const promise=new Promise(r=>resolve=r);hold={promise};return ()=>{hold=null;resolve();};},
    expire:async()=>{const s=app(),creds=await unseal(await s.get('tokens'),env.DATA_KEY);creds.expires=0;await s.stmt("UPDATE kv SET v=? WHERE k='tokens'",JSON.stringify(await seal(creds,env.DATA_KEY))).run();}
  };
}

test('static app and setup load before secrets exist; private routes report missing config',async()=>{
  const worker=createWorker();
  const page=await worker.fetch(new Request(origin+'/'),{});assert.equal(page.status,200);assert.match(await page.text(),/交車日誌/);
  const setup=await worker.fetch(new Request(origin+'/setup'),{});assert.equal(setup.status,200);assert.match(await setup.text(),/DATA_KEY/);
  const api=await worker.fetch(new Request(origin+'/api/state'),{});assert.equal(api.status,503);assert.equal((await api.json()).setupRequired,true);
  assert.equal((await worker.fetch(new Request(origin+'/model.mjs'),{})).status,200);
});
test('auth, origin enforcement, secure cookies and logout',async t=>{
  const f=await fixture(t);assert.equal((await f.req('/api/state')).status,401);
  assert.equal((await f.req('/api/login','POST',{password:f.env.APP_PASSWORD},{origin:'https://evil.example'})).status,403);
  const r=await f.login();assert.match(r.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Lax/);
  assert.equal((await f.req('/api/state')).status,200);
  assert.equal((await f.req('/api/logout','POST',{})).status,200);assert.equal((await f.req('/api/state')).status,401);
});
test('login throttling persists across Workers isolates',async t=>{
  const f=await fixture(t);
  for(let i=0;i<10;i++)assert.equal((await f.req('/api/login','POST',{password:'bad'})).status,401);
  const second=createWorker();const r=await second.fetch(new Request(origin+'/api/login',{method:'POST',headers:{origin},body:JSON.stringify({password:f.env.APP_PASSWORD})}),f.env);
  assert.equal(r.status,429);
});
test('public domain key persists; private key is encrypted and unavailable via HTTP',async t=>{
  const f=await fixture(t);const first=await (await f.req('/.well-known/appspecific/com.tesla.3p.public-key.pem')).text();
  assert.match(first,/BEGIN PUBLIC KEY/);assert.equal(await (await f.req('/.well-known/appspecific/com.tesla.3p.public-key.pem')).text(),first);
  const stored=await f.app().get('domainKey');assert.ok(stored.privateKey.ciphertext);assert.ok(!JSON.stringify(stored).includes('BEGIN PRIVATE KEY'));
  assert.equal((await f.req('/private-key.pem')).status,404);
});
test('OAuth state binds to session, is consumed atomically and cannot be replayed',async t=>{
  const f=await fixture(t);const state=await f.authorize();
  assert.equal((await f.req('/auth/callback?state='+state+'&code=replay')).status,400);
  const pending=await f.begin();await f.login();
  assert.equal((await f.req('/auth/callback?state='+pending+'&code=wrong-session')).status,400);
  const result=await f.app().state();assert.equal(result.connected,true);assert.equal(result.orders.length,1);assert.equal(result.history.length,0);
  assert.ok(!JSON.stringify(result).includes('private-token'));
  const raw=f.DB.db.prepare("SELECT v FROM kv WHERE k='tokens'").get().v;assert.ok(!raw.includes('private-token'));assert.ok(!raw.includes('refresh-private'));
});
test('cloud registration can run from phone without exposing partner token',async t=>{
  const f=await fixture(t);await f.login();const r=await f.req('/api/register','POST',{});assert.equal(r.status,200);
  const response=await r.json();assert.equal(response.registered.origin,origin);assert.ok(!JSON.stringify(response).includes('private-token'));
  const call=f.calls.find(c=>c.url.endsWith('/partner_accounts'));assert.deepEqual(JSON.parse(call.options.body),{domain:new URL(origin).hostname});
});
test('sync logs real changes, rejects malformed payload, and preserves missing orders',async t=>{
  const f=await fixture(t);await f.authorize();
  f.setData({response:[{referenceNumber:'RN123',modelCode:'MY',orderStatus:'ORDERED',vin:'XP7YGCEK0RB123456'}]});
  await f.app().stmt("DELETE FROM kv WHERE k='lastAttempt'").run();await f.app().sync(true);
  assert.equal((await f.app().state()).history.length,1);
  f.setData({response:'bad'});await f.app().stmt("DELETE FROM kv WHERE k='lastAttempt'").run();await assert.rejects(f.app().sync(true));assert.equal((await f.app().state()).orders[0].active,true);
  f.setData({response:[]});await f.app().stmt("DELETE FROM kv WHERE k='lastAttempt'").run();await f.app().sync(true);
  const s=await f.app().state();assert.equal(s.orders[0].active,false);assert.equal(s.orders[0].status,'ORDERED');
});
test('cross-isolate lease prevents duplicate refresh and new tokens persist',async t=>{
  const f=await fixture(t);await f.authorize();await f.expire();await f.app().stmt("DELETE FROM kv WHERE k='lastAttempt'").run();
  const release=f.blockTokens(),first=f.app().sync(true);
  // Wait for the first request to reach the deliberately blocked token exchange.
  for(let i=0;i<30&&!f.calls.some(c=>c.options.body?.get('grant_type')==='refresh_token');i++)await new Promise(r=>setImmediate(r));
  await assert.rejects(service({...f.env,DB:new D1(f.DB.db)}).sync(true),e=>e.status===409);
  release();await first;
  const tokens=await unseal(await f.app().get('tokens'),f.env.DATA_KEY);assert.match(tokens.refresh_token,/refresh-private/);assert.ok(tokens.expires>Date.now());
});
test('disconnect fences an in-flight refresh; stale code cannot restore credentials',async t=>{
  const f=await fixture(t);await f.authorize();await f.expire();await f.app().stmt("DELETE FROM kv WHERE k='lastAttempt'").run();
  const release=f.blockTokens(),pending=f.app().sync(true);
  for(let i=0;i<30&&!f.calls.some(c=>c.options.body?.get('grant_type')==='refresh_token');i++)await new Promise(r=>setImmediate(r));
  assert.equal((await f.req('/api/disconnect','POST',{})).status,200);release();await assert.rejects(pending);
  assert.equal((await f.app().state()).connected,false);assert.equal(await f.app().get('tokens'),null);assert.equal((await f.app().state()).orders.length,1);
});
test('disconnect cancels pending OAuth callbacks before a new lease can connect',async t=>{
  const f=await fixture(t);await f.login();const state=await f.begin();
  assert.equal((await f.req('/api/disconnect','POST',{})).status,200);
  const r=await f.req('/auth/callback?state='+state+'&code=cancelled-code');assert.equal(r.status,400);assert.equal(f.calls.length,0);
  const fresh=await f.begin(),release=f.blockTokens();
  const pending=f.req('/auth/callback?state='+fresh+'&code=in-flight-code');
  for(let i=0;i<30&&!f.calls.some(c=>c.url.includes('/token'));i++)await new Promise(r=>setImmediate(r));
  await f.req('/api/disconnect','POST',{});release();await pending;
  assert.equal(await f.app().get('tokens'),null);
});
test('free-tier order limit never silently truncates the upstream active list',async t=>{
  const f=await fixture(t);await f.authorize();await f.app().stmt("DELETE FROM kv WHERE k='lastAttempt'").run();
  f.setData({response:Array.from({length:11},(_,i)=>({referenceNumber:'RN'+i}))});await assert.rejects(f.app().sync(true));
  const s=await f.app().state();assert.equal(s.orders.length,1);assert.equal(s.orders[0].active,true);
});
test('429 backoff survives service recreation; 401 removes authorization',async t=>{
  const f=await fixture(t);await f.authorize();await f.app().stmt("DELETE FROM kv WHERE k='lastAttempt'").run();f.setStatus(429);await assert.rejects(f.app().sync(true));
  const n=f.calls.length;await assert.rejects(f.app().sync(true),e=>e.status===429);assert.equal(f.calls.length,n);assert.ok(await f.app().get('nextAllowed')>Date.now());
  const g=await fixture(t);await g.authorize();await g.app().stmt("DELETE FROM kv WHERE k='lastAttempt'").run();g.setStatus(401);await assert.rejects(g.app().sync(true));assert.equal((await g.app().state()).connected,false);
});
test('scheduled sync runs without a browser and respects configured interval',async t=>{
  const f=await fixture(t);await f.authorize();await f.app().stmt("DELETE FROM kv WHERE k='lastAttempt'").run();
  const n=f.calls.length;let work;await f.worker.scheduled({},f.env,{waitUntil:p=>work=p});await work;assert.equal(f.calls.length,n+1);
  await f.worker.scheduled({},f.env,{waitUntil:p=>work=p});await work;assert.equal(f.calls.length,n+1);
});
test('wrong encryption key and oversized payload never leak stored secrets',async t=>{
  const f=await fixture(t);await f.authorize();await f.app().stmt("DELETE FROM kv WHERE k='lastAttempt'").run();
  await assert.rejects(service({...f.env,DATA_KEY:'cd'.repeat(32)}).sync(true));assert.equal((await f.app().state()).orders.length,1);
  assert.equal((await f.req('/api/login','POST',{password:'x'.repeat(17000)})).status,413);
});
