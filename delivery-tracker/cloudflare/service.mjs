import {normalizeOrders, changes} from '../model.mjs';
import {seal,unseal,random,domainKeys} from './crypto.mjs';
import {SCHEMA} from './schema.mjs';

export class AppError extends Error {
  constructor(status,message) {super(message);this.status=status;}
}
export function missingConfig(env) {
  const missing=[];
  if (!env.DB) missing.push('D1 binding: DB');
  if (!env.APP_PASSWORD || env.APP_PASSWORD.length<16) missing.push('APP_PASSWORD（至少 16 字元）');
  if (!/^[0-9a-f]{64}$/i.test(env.DATA_KEY||'')) missing.push('DATA_KEY（64 位十六進位）');
  try {const u=new URL(env.PUBLIC_URL);if(u.protocol!=='https:' || u.username || u.password || u.pathname!=='/' || u.search || u.hash) throw new Error();}
  catch {missing.push('PUBLIC_URL（正式 HTTPS origin）');}
  return missing;
}
const ready = new WeakMap();
export async function initialize(db) {
  if (!ready.has(db)) {
    const p=db.exec(SCHEMA).catch(e=>{ready.delete(db);throw e;});ready.set(db,p);
  }
  await ready.get(db);
}

export function service(env, fetcher=fetch) {
  const db=env.DB;
  const origin=new URL(env.PUBLIC_URL).origin;
  const base=env.TESLA_API_BASE||'https://fleet-api.prd.na.vn.cloud.tesla.com';
  if (!['https://fleet-api.prd.na.vn.cloud.tesla.com','https://fleet-api.prd.eu.vn.cloud.tesla.com'].includes(base)) throw new AppError(503,'TESLA_API_BASE 設定錯誤。');
  const interval=Number(env.POLL_MINUTES||30);
  if (!Number.isFinite(interval)||interval<30||interval>1440) throw new AppError(503,'雲端版本的 POLL_MINUTES 必須介於 30–1440。');
  const stmt=(sql,...args)=>db.prepare(sql).bind(...args);
  const get=async key=>{const r=await stmt('SELECT v FROM kv WHERE k=?',key).first();return r?JSON.parse(r.v):null;};
  // A DB lease serializes OAuth exchange, refresh, disconnect and registration
  // across Workers isolates, rather than relying on an in-memory promise.
  const GUARD="EXISTS (SELECT 1 FROM locks WHERE name='tesla' AND owner=?)";
  const kv=(key,value,owner)=>stmt(`INSERT OR REPLACE INTO kv SELECT ?,? WHERE ${GUARD}`,key,JSON.stringify(value),owner);
  async function save(key,value,owner) {
    const r=await kv(key,value,owner).run();
    if (!r.meta.changes) throw new AppError(409,'同步鎖已到期，請重新操作。');
  }
  async function locked(fn) {
    const owner=random(),now=Date.now();
    const row=await stmt(`INSERT INTO locks VALUES ('tesla',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE locks.expires<? RETURNING owner`,owner,now+180000,now).first();
    if (!row) throw new AppError(409,'正在同步或處理授權，請稍後再試。');
    try {return await fn(owner);} finally {await stmt("DELETE FROM locks WHERE name='tesla' AND owner=?",owner).run();}
  }
  async function request(url,options={}) {
    const r=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(20000)});
    if (!r.ok) {
      const e=new AppError(r.status,'Tesla 服務暫時無法完成要求。');
      const retry=r.headers.get('retry-after');
      e.retryAfter=retry && /^\d+$/.test(retry) ? Number(retry)*1000 : Math.max(0,Date.parse(retry)-Date.now())||0;
      throw e;
    }
    return r.json();
  }
  async function token(form,owner) {
    const result=await request('https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form)});
    if(typeof result.access_token!=='string'||typeof result.refresh_token!=='string'||!Number.isFinite(Number(result.expires_in))) throw new AppError(502,'Tesla 授權回應不完整。');
    const saved={access_token:result.access_token,refresh_token:result.refresh_token,expires:Date.now()+Number(result.expires_in)*1000};
    await save('tokens',await seal(saved,env.DATA_KEY),owner);
    return saved;
  }
  async function syncInside(owner,manual=false,initial=false) {
    const stored=await get('tokens');if(!stored)return {skipped:'disconnected'};
    const now=Date.now(),next=await get('nextAllowed')||0,last=await get('lastAttempt')||0;
    if (now<next || (!initial && now<last+(manual?60000:interval*60000))) {
      if(manual)throw new AppError(429,'請稍後再同步，避免頻繁呼叫 Tesla。');
      return {skipped:'interval'};
    }
    await save('lastAttempt',now,owner);
    try {
      let creds=await unseal(stored,env.DATA_KEY);
      if(creds.expires<Date.now()+60000)creds=await token({grant_type:'refresh_token',client_id:env.TESLA_CLIENT_ID,refresh_token:creds.refresh_token},owner);
      const rows=normalizeOrders(await request(base+'/api/1/users/orders',{headers:{Authorization:'Bearer '+creds.access_token}}));
      // Bounds CPU, DB work and payload growth on the free tier. Never truncate
      // upstream results and misclassify omitted orders as inactive.
      if(rows.length>10)throw new AppError(502,'有效訂單超過此私人版本支援的 10 筆。');
      const old=(await stmt('SELECT id,json FROM orders').all()).results;
      const previous=new Map(old.map(r=>[r.id,JSON.parse(r.json)]));
      const at=new Date().toISOString(),batch=[stmt(`UPDATE orders SET active=0 WHERE ${GUARD}`,owner)];
      for(const order of rows) {
        const diff=changes(previous.get(order.id),order);
        batch.push(stmt(`INSERT OR REPLACE INTO orders SELECT ?,?,1 WHERE ${GUARD}`,order.id,JSON.stringify(order),owner));
        if(diff.length)batch.push(stmt(`INSERT INTO history(order_id,at,json) SELECT ?,?,? WHERE ${GUARD}`,order.id,at,JSON.stringify(diff),owner));
      }
      batch.push(kv('lastSuccess',at,owner),kv('error',null,owner),kv('nextAllowed',0,owner));
      const result=await db.batch(batch);
      if(!result.at(-1).meta.changes)throw new AppError(409,'同步鎖已到期，未保存本次結果。');
      return {ok:true};
    } catch(e) {
      const error=e.status===401?'Tesla 授權已失效，請重新連接。':e.status===403?'Tesla 拒絕存取，請確認應用註冊與授權範圍。':e.status===402?'Tesla API 需要確認帳務；本服務不會替你調高消費限額。':e.status===429?'Tesla 限制請求頻率，已延後重試。':'同步未完成，保留上次資料；請稍後重試。';
      const batch=[kv('error',error,owner)];
      if(e.status===401)batch.push(stmt(`DELETE FROM kv WHERE k='tokens' AND ${GUARD}`,owner));
      if(e.status===429)batch.push(kv('nextAllowed',Date.now()+Math.max(interval*60000,e.retryAfter||0),owner));
      await db.batch(batch);throw new AppError(e.status===409?409:502,error);
    }
  }
  async function state() {
    const results=await db.batch([stmt("SELECT k,v FROM kv WHERE k IN ('tokens','lastSuccess','error','registered')"),stmt('SELECT json,active FROM orders ORDER BY id'),stmt('SELECT * FROM history ORDER BY id DESC LIMIT 300')]);
    const values=new Map(results[0].results.map(r=>[r.k,JSON.parse(r.v)]));
    return {runtime:'cloudflare',configured:Boolean(env.TESLA_CLIENT_ID&&env.TESLA_CLIENT_SECRET),connected:Boolean(values.get('tokens')),registered:values.get('registered')||null,
      lastSuccess:values.get('lastSuccess')||null,error:values.get('error')||null,pollMinutes:interval,
      orders:results[1].results.map(r=>({...JSON.parse(r.json),active:Boolean(r.active)})),
      history:results[2].results.map(r=>({id:r.id,orderId:r.order_id,at:r.at,changes:JSON.parse(r.json)}))};
  }
  async function publicKey() {
    let saved=await get('domainKey');
    if(!saved) {
      const generated=await domainKeys(env.DATA_KEY);
      await stmt("INSERT OR IGNORE INTO kv VALUES ('domainKey',?)",JSON.stringify(generated)).run();
      saved=await get('domainKey');
    }
    return saved.publicKey;
  }
  async function register() {
    if(!env.TESLA_CLIENT_ID||!env.TESLA_CLIENT_SECRET)throw new AppError(503,'請先設定 Tesla Client ID 與 Secret。');
    return locked(async owner=>{
      await publicKey();
      const result=await request('https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:env.TESLA_CLIENT_ID,client_secret:env.TESLA_CLIENT_SECRET,audience:base,scope:'user_data'})});
      if(!result.access_token)throw new AppError(502,'Tesla 未提供 Partner Token。');
      await request(base+'/api/1/partner_accounts',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+result.access_token},body:JSON.stringify({domain:new URL(origin).hostname})});
      const registered={at:new Date().toISOString(),origin,base};await save('registered',registered,owner);return {ok:true,registered};
    });
  }
  async function disconnect() {
    // Bump the fence and delete credentials in a single D1 transaction. A stale
    // in-flight token refresh can never restore tokens after this commits.
    await db.batch([stmt("DELETE FROM locks WHERE name='tesla'"),stmt("DELETE FROM kv WHERE k IN ('tokens','error','nextAllowed')"),stmt('DELETE FROM oauth')]);
  }
  async function cleanup() {
    await db.batch([stmt('DELETE FROM sessions WHERE expires<?',Date.now()),stmt('DELETE FROM oauth WHERE expires<?',Date.now()),stmt('DELETE FROM attempts WHERE expires<?',Date.now())]);
  }
  async function connectInside(code,owner) {
    try { await token({grant_type:'authorization_code',client_id:env.TESLA_CLIENT_ID,client_secret:env.TESLA_CLIENT_SECRET,audience:base,redirect_uri:origin+'/auth/callback',code},owner); }
    catch(e) { await save('error','Tesla 授權交換未完成，請確認應用設定後重新連接。',owner); throw new AppError(502,'Tesla 授權交換未完成。'); }
    await save('nextAllowed',0,owner);await syncInside(owner,false,true);
  }
  return {stmt,get,locked,state,publicKey,register,disconnect,cleanup,
    sync:manual=>locked(owner=>syncInside(owner,manual)),
    callback:(stateHash,sessionHash,code)=>locked(async owner=>{
      // Acquire the fence BEFORE consuming state. If disconnect happened while
      // the callback was queued, it has already removed this OAuth state.
      const pending=await stmt('DELETE FROM oauth WHERE state=? AND session=? AND expires>? RETURNING state',stateHash,sessionHash,Date.now()).first();
      if(!pending)throw new AppError(400,'授權已過期或驗證失敗，請重新連接。');
      if(!code)return {cancelled:true};
      await connectInside(code,owner);return {ok:true};
    })};
}
