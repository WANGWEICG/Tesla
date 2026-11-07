import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { normalizeOrders, changes, vinBasics } from '../model.mjs';

const origin = 'http://localhost:3000';
async function fixture(t, options={}) {
  const dir = mkdtempSync(join(tmpdir(),'delivery-test-'));
  let payload = {response:[{referenceNumber:'RN123',modelCode:'MY',vin:'',orderStatus:'ORDERED'}]}, calls=[], mode=200, expires=3600;
  const fetcher = async (url, init) => {
    calls.push({url,init});
    if (url.includes('/token')) return new Response(JSON.stringify({access_token:'secret-access',refresh_token:'secret-refresh-' + calls.length,expires_in:expires}),{status:200});
    return new Response(JSON.stringify(mode===200 ? payload : {error:'private Tesla detail must not leak'}),{status:mode,headers:mode===429 ? {'retry-after':'600'} : {}});
  };
  const env = {APP_PASSWORD:'a-very-long-private-password',DATA_KEY:'ab'.repeat(32),DATA_DIR:dir,PUBLIC_URL:origin,TESLA_CLIENT_ID:'client',TESLA_CLIENT_SECRET:'secret',POLL_MINUTES:'30',...options};
  const app = createApp(env,fetcher);
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const address = 'http://127.0.0.1:'+app.server.address().port;
  let cookie='';
  const req = (path, method='GET', data, extra={}) => fetch(address+path,{method,redirect:'manual',headers:{cookie, ...(method==='POST'?{origin,'Content-Type':'application/json'}:{}),...extra},body:data===undefined?undefined:JSON.stringify(data)});
  async function login(){ const r=await req('/api/login','POST',{password:env.APP_PASSWORD});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];return r; }
  async function authorize(){const r=await req('/auth/tesla');assert.equal(r.status,302);const state=new URL(r.headers.get('location')).searchParams.get('state');const result=await req('/auth/callback?state='+state+'&code=one-use-code');assert.equal(result.status,302);return state;}
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  return {app,env,dir,req,login,authorize,calls,setPayload:v=>payload=v,setMode:v=>mode=v,setExpires:v=>expires=v};
}

test('normalization preserves unknown fields as empty; no inferred shipping or delivery',()=>{
  const o=normalizeOrders({response:[{referenceNumber:'RN1',vin:'XP7YGCEK0RB123456'}]})[0];
  assert.equal(o.status,'');assert.equal(o.deliveryDate,'');assert.equal(o.deliveryWindow,'');
  assert.deepEqual(changes(null,o),[]);
  assert.throws(()=>normalizeOrders({response:{orders:[]}}));
  assert.throws(()=>normalizeOrders({response:[{vin:'x'}]}));
  assert.throws(()=>normalizeOrders({response:[{referenceNumber:'RN1'},{referenceNumber:'RN1'}]}));
  assert.equal(vinBasics('invalid'),null);assert.equal(vinBasics('XP7YGCEK0RB123456').factory,'柏林');
  assert.equal(changes(o,{...o,vin:''})[0].field,'vin');
});

test('requires strong configuration and safe API target',()=>{
  assert.throws(()=>createApp({APP_PASSWORD:'short'}));
  assert.throws(()=>createApp({APP_PASSWORD:'long-password-123',DATA_KEY:'ab'.repeat(32),PUBLIC_URL:'http://public.example'}));
  assert.throws(()=>createApp({APP_PASSWORD:'long-password-123',DATA_KEY:'ab'.repeat(32),TESLA_API_BASE:'https://evil.example'}));
});

test('private endpoints, origin checks, public key, no private key route',async t=>{
  const f=await fixture(t);
  assert.equal((await f.req('/api/state')).status,401);
  assert.equal((await f.req('/api/login','POST',{password:f.env.APP_PASSWORD},{origin:'https://evil.example'})).status,403);
  const login=await f.login();assert.match(login.headers.get('set-cookie'),/HttpOnly/);assert.match(login.headers.get('set-cookie'),/SameSite=Lax/);
  const key=await f.req('/.well-known/appspecific/com.tesla.3p.public-key.pem');assert.match(await key.text(),/BEGIN PUBLIC KEY/);
  assert.equal((await f.req('/private-key.pem')).status,404);
  assert.equal((await f.req('/data/tracker.sqlite')).status,404);
  assert.equal((await f.req('/api/logout','POST',{})).status,200);
  assert.equal((await f.req('/api/state')).status,401);
});

test('OAuth binds state to session, rejects replay, encrypts tokens and does first sync',async t=>{
  const f=await fixture(t);await f.login();
  assert.equal((await f.req('/auth/callback?state=wrong&code=secret')).status,400);
  const state=await f.authorize();
  assert.equal((await f.req('/auth/callback?state='+state+'&code=replay')).status,400);
  const result=await (await f.req('/api/state')).json();assert.equal(result.orders.length,1);assert.equal(result.history.length,0);assert.equal(result.connected,true);
  assert.ok(!JSON.stringify(result).includes('secret-access'));
  const db=new DatabaseSync(join(f.dir,'tracker.sqlite'));const token=db.prepare("SELECT v FROM kv WHERE k='tokens'").get().v;
  assert.ok(!token.includes('secret-access'));assert.ok(!token.includes('secret-refresh'));db.close();
  const exchange=f.calls.find(c=>c.url.includes('/token'));assert.equal(exchange.init.body.get('client_id'),'client');assert.equal(exchange.init.body.get('redirect_uri'),origin+'/auth/callback');
});

test('changes and missing active orders are recorded honestly; invalid response preserves snapshot',async t=>{
  const f=await fixture(t);await f.login();await f.authorize();
  f.setPayload({response:[{referenceNumber:'RN123',modelCode:'MY',vin:'XP7YGCEK0RB123456',orderStatus:'ORDERED',deliveryWindow:'2026/12/01–12/15'}]});
  await f.app.sync(true);let s=f.app.state();assert.equal(s.history.length,1);assert.equal(s.history[0].changes.length,2);
  await f.app.sync(true);assert.equal(f.app.state().history.length,1);
  f.setPayload({response:{invalid:true}});await assert.rejects(f.app.sync(true));assert.equal(f.app.state().orders[0].active,true);
  f.setPayload({response:[]});await f.app.sync(true);s=f.app.state();assert.equal(s.orders[0].active,false);assert.equal(s.orders[0].status,'ORDERED');
});

test('single-flight sync rotates refresh tokens and disconnect prevents later polling',async t=>{
  const f=await fixture(t);f.setExpires(0);await f.login();await f.authorize();
  const count=f.calls.length;await Promise.all([f.app.sync(true),f.app.sync(true),f.app.sync(true)]);assert.equal(f.calls.length-count,2);
  const tokens=f.calls.filter(c=>c.url.includes('/token'));assert.equal(tokens.at(-1).init.body.get('grant_type'),'refresh_token');assert.notEqual(tokens.at(-1).init.body.get('refresh_token'),'secret-refresh-1');
  assert.equal((await f.req('/api/disconnect','POST',{})).status,200);assert.equal(f.app.state().connected,false);
  await assert.rejects(f.app.sync(true));assert.equal(f.app.state().orders.length,1);
});

test('429 backoff, manual rate limit, and 401 reauthorization',async t=>{
  const f=await fixture(t);await f.login();await f.authorize();
  assert.equal((await f.req('/api/sync','POST',{})).status,429);
  f.setMode(429);await assert.rejects(f.app.sync(true));const n=f.calls.length;await f.app.sync(true);assert.equal(f.calls.length,n);assert.match(f.app.state().error,/頻率/);
  const g=await fixture(t);await g.login();await g.authorize();g.setMode(401);await assert.rejects(g.app.sync(true));assert.equal(g.app.state().connected,false);assert.equal(g.app.state().orders.length,1);
});

test('login attempts are throttled',async t=>{
  const f=await fixture(t);
  for(let i=0;i<10;i++)assert.equal((await f.req('/api/login','POST',{password:'wrong'})).status,401);
  assert.equal((await f.req('/api/login','POST',{password:f.env.APP_PASSWORD})).status,429);
});
