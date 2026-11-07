// Run once per API region after deploying and configuring the developer app.
// Uses env secrets directly; never prints access tokens or server response bodies.
const base = process.env.TESLA_API_BASE || 'https://fleet-api.prd.na.vn.cloud.tesla.com';
if (!['https://fleet-api.prd.na.vn.cloud.tesla.com','https://fleet-api.prd.eu.vn.cloud.tesla.com'].includes(base)) throw new Error('不支援的 API 區域');
const origin = new URL(process.env.PUBLIC_URL).origin;
if (!origin.startsWith('https:') || !process.env.TESLA_CLIENT_ID || !process.env.TESLA_CLIENT_SECRET) throw new Error('請先設定正式 HTTPS 網址與 Client ID／Secret');
async function request(url, options) {
  const r = await fetch(url, { ...options, redirect:'error', signal:AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Tesla 註冊未完成：HTTP ${r.status}，請確認公開金鑰、應用設定與帳務。`);
  return r.json();
}
const t = await request('https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token', {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({grant_type:'client_credentials', client_id:process.env.TESLA_CLIENT_ID, client_secret:process.env.TESLA_CLIENT_SECRET, audience:base, scope:'user_data'})});
if (!t.access_token) throw new Error('未取得 Partner Token');
await request(base + '/api/1/partner_accounts', {method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+t.access_token},body:JSON.stringify({domain:new URL(origin).hostname})});
console.log('Tesla 區域註冊完成，可以從私人服務網頁進行官方授權。');
