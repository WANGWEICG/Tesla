import {service,initialize,missingConfig,AppError} from './service.mjs';
import {random,hash,equalSecret} from './crypto.mjs';
import {ASSETS} from './generated-assets.mjs';

const SECURITY={
  'Cache-Control':'no-store',
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};
const json=(status,value,extra={})=>new Response(JSON.stringify(value),{status,headers:{...SECURITY,'Content-Type':'application/json; charset=utf-8',...extra}});
const redirect=path=>new Response(null,{status:302,headers:{...SECURITY,Location:path}});
const cookie=value=>`delivery_session=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${value?604800:0}`;
async function body(request) {
  if(Number(request.headers.get('content-length'))>16384)throw new AppError(413,'資料過大。');
  const reader=request.body?.getReader();if(!reader)return {};
  const chunks=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();throw new AppError(413,'資料過大。');}chunks.push(value);}
  const data=new Uint8Array(size);let offset=0;for(const part of chunks){data.set(part,offset);offset+=part.length;}
  try{return JSON.parse(new TextDecoder().decode(data)||'{}');}catch{throw new AppError(400,'資料格式錯誤。');}
}
export function createWorker(fetcher=fetch) {
  return {
    async fetch(request,env) {
      try {
        const url=new URL(request.url),path=url.pathname;
        if(Object.hasOwn(ASSETS,path)) {
          if(request.method!=='GET'&&request.method!=='HEAD')return json(405,{error:'不支援此方法。'});
          const [type,content]=ASSETS[path];return new Response(request.method==='HEAD'?null:content,{headers:{...SECURITY,'Content-Type':type+'; charset=utf-8'}});
        }
        const missing=missingConfig(env);
        if(missing.length)return json(503,{setupRequired:true,error:'請先在 Cloudflare Settings → Variables and Secrets 完成設定：'+missing.join('、')});
        const origin=new URL(env.PUBLIC_URL).origin;
        if(url.origin!==origin)return json(403,{error:'請使用 PUBLIC_URL 設定的正式服務網址。'});
        if(request.method==='POST'&&request.headers.get('origin')!==origin)return json(403,{error:'來源驗證失敗，請在服務網址操作。'});
        await initialize(env.DB);
        const app=service(env,fetcher),stmt=app.stmt;
        if(path==='/.well-known/appspecific/com.tesla.3p.public-key.pem'&&request.method==='GET')return new Response(await app.publicKey(),{headers:{...SECURITY,'Content-Type':'application/x-pem-file'}});
        const value=/(?:^|;\s*)delivery_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get('cookie')||'')?.[1];
        const session=value&&await stmt('SELECT hash FROM sessions WHERE hash=? AND expires>?',await hash(value),Date.now()).first();
        if(path==='/api/login'&&request.method==='POST') {
          const input=await body(request),key=await hash(request.headers.get('CF-Connecting-IP')||'unknown');
          const now=Date.now();
          const attempt=await stmt(`INSERT INTO attempts VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN attempts.expires<? THEN 1 ELSE attempts.count+1 END,expires=CASE WHEN attempts.expires<? THEN excluded.expires ELSE attempts.expires END RETURNING count`,key,now+900000,now,now).first();
          if(attempt.count>10)return json(429,{error:'嘗試次數過多，請 15 分鐘後再試。'});
          if(!await equalSecret(String(input.password||''),env.APP_PASSWORD))return json(401,{error:'私人存取密碼錯誤。'});
          const token=random();await env.DB.batch([stmt('DELETE FROM attempts WHERE key=?',key),stmt('INSERT INTO sessions VALUES (?,?)',await hash(token),now+604800000)]);
          return json(200,{ok:true},{'Set-Cookie':cookie(token)});
        }
        if(path.startsWith('/api/')||path.startsWith('/auth/')) {
          if(!session)return json(401,{error:'請先輸入私人存取密碼。'});
          if(path==='/api/state'&&request.method==='GET')return json(200,await app.state());
          if(path==='/api/sync'&&request.method==='POST') {
            if(!await app.get('tokens'))throw new AppError(409,'請先連接 Tesla 帳號。');
            await app.sync(true);return json(200,await app.state());
          }
          if(path==='/api/register'&&request.method==='POST')return json(200,await app.register());
          if(path==='/api/disconnect'&&request.method==='POST'){await app.disconnect();return json(200,{ok:true});}
          if(path==='/api/logout'&&request.method==='POST') {
            await stmt('DELETE FROM sessions WHERE hash=?',session.hash).run();return json(200,{ok:true},{'Set-Cookie':cookie('')});
          }
          if(path==='/auth/tesla'&&request.method==='GET') {
            if(!env.TESLA_CLIENT_ID||!env.TESLA_CLIENT_SECRET)throw new AppError(503,'請先設定 Tesla Client ID 與 Secret。');
            const state=random();
            await env.DB.batch([stmt('DELETE FROM oauth WHERE session=? OR expires<?',session.hash,Date.now()),stmt('INSERT INTO oauth VALUES (?,?,?)',await hash(state),session.hash,Date.now()+600000)]);
            const auth=new URL('https://auth.tesla.com/oauth2/v3/authorize');
            auth.search=new URLSearchParams({response_type:'code',client_id:env.TESLA_CLIENT_ID,redirect_uri:origin+'/auth/callback',scope:'openid offline_access user_data',state,locale:'zh-TW'});
            return redirect(auth.href);
          }
          if(path==='/auth/callback'&&request.method==='GET') {
            try {
              const result=await app.callback(await hash(url.searchParams.get('state')||''),session.hash,url.searchParams.has('error')?null:url.searchParams.get('code'));
              if(result.cancelled)return redirect('/?auth=cancelled');
            } catch(e){if(e.status!==502)throw e;} // Saved error is shown on the dashboard.
            return redirect('/');
          }
        }
        return json(404,{error:'找不到頁面或功能。'});
      } catch(e) {
        // Neither token response bodies nor auth codes go into logs/errors.
        return json(e instanceof AppError?e.status:500,{error:e instanceof AppError?e.message:'操作未完成，請檢查 D1 綁定或服務設定後重試。'});
      }
    },
    async scheduled(controller,env,ctx) {
      if(missingConfig(env).length)return;
      const run=(async()=>{
        await initialize(env.DB);const app=service(env,fetcher);
        await app.cleanup();
        try{await app.sync(false);}catch(e){if(e.status!==409)throw new Error('Scheduled Tesla sync did not complete; check private dashboard.');}
      })();
      // Return/reject only a sanitized exception to Cloudflare's scheduler.
      ctx.waitUntil(run);
    }
  };
}
export default createWorker();
