import { vinBasics } from '../model.mjs';
const $ = id => document.getElementById(id);
const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const labels = { vin:'VIN', status:'訂單狀態', deliveryWindow:'預計交期', deliveryDate:'交車日期', configuration:'車型配置', model:'車款' };
let current = null, latestEvent = null, fetching = false, checkId = '';
const localKey = 'tesla-delivery-checks-v1';
let checks = {}; try { checks = JSON.parse(localStorage.getItem(localKey) || '{}'); if (!checks || typeof checks !== 'object' || Array.isArray(checks)) checks = {}; } catch {}
const items = [
  ['documents','文件與車籍','核對車身、文件 VIN，確認保險生效、領牌與付款資料。'],
  ['paint','車漆與鈑件','在充足光線下檢查刮傷、凹痕、色差與鈑件接縫。'],
  ['glass','玻璃與燈具','檢查玻璃裂痕，測試頭燈、方向燈與雨刷。'],
  ['wheels','輪胎與輪圈','確認輪圈外觀、胎壓及輪胎狀況。'],
  ['interior','座椅與內裝','檢查飾板、座椅、天篷，測試座椅調整與安全帶。'],
  ['display','螢幕與空調','測試螢幕、音響、鏡頭與空調冷房。'],
  ['charging','充電與配件','確認充電口、充電功能、鑰匙卡與交付配件。'],
  ['account','帳號與手機鑰匙','確認 Tesla App 車輛權限及手機鑰匙設定。'],
  ['issues','問題紀錄','拍照記錄待處理項目，與交付人員確認後續處理方式。']
];
function message(value) { $('message').textContent = value; $('message').hidden = !value; }
async function api(path, data) {
  const response = await fetch('/api/' + path, { method: data === undefined ? 'GET' : 'POST', headers: data === undefined ? {} : { 'Content-Type':'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), cache:'no-store' });
  const payload = await response.json();
  if (payload.setupRequired) { $('cloudflare-setup').hidden=false; $('workspace').hidden=true; $('login').hidden=true; }
  if (!response.ok) { if (response.status === 401) { $('login').hidden = false; $('workspace').hidden = true; current = null; } throw new Error(payload.error || '服務暫時無法使用'); }
  return payload;
}
function fmt(v) { if (!v) return '尚未同步'; const d = new Date(v); return isNaN(d) ? v : d.toLocaleString('zh-TW', {timeZone:'Asia/Taipei'}); }
function render(state) {
  current = state; $('cloudflare-setup').hidden=true; $('login').hidden = true; $('workspace').hidden = false;
  $('connection').textContent = state.connected ? '● Tesla 已連接' : '○ Tesla 未連接';
  $('updated').textContent = state.lastSuccess ? '最後成功同步 ' + fmt(state.lastSuccess) : '等候第一次同步';
  $('auth-description').textContent = state.configured ? `後端每 ${state.pollMinutes} 分鐘檢查一次訂單。請在 Tesla 官方頁面登入及授權。` : '後端尚未設定 Tesla Client ID 與 Secret，請先完成開發者應用設定。';
  $('connect').hidden = !state.configured;
  $('register').hidden = state.runtime!=='cloudflare'||!state.configured;
  $('registration').hidden = state.runtime!=='cloudflare';
  $('registration').textContent = state.registered ? '此服務已於 '+fmt(state.registered.at)+' 完成區域註冊。' : '設定 Tesla Developer 的 origin 與回呼網址後，先按「註冊 Tesla 應用網域」，再進行官方授權。網域能否被 Tesla 接受仍需實際確認。';
  $('connect').textContent = state.connected ? '重新連接 Tesla ↗' : '前往 Tesla 官方授權 ↗';
  $('disconnect').hidden = !state.connected; $('sync').disabled = !state.connected;
  if (state.error) message(state.error);
  $('order-list').innerHTML = state.orders.length ? state.orders.map(o => {
    const vin = vinBasics(o.vin);
    return `<article class="order-card"><div class="order-top"><div><p class="eyebrow">${escape(o.source)}</p><h3>${escape(o.model || '車款未提供')}</h3><span class="order-id">${escape(o.id)}</span></div><span class="badge">${o.active ? '有效訂單' : '已不在有效清單'}</span></div><div class="metrics"><div class="metric"><small>TESLA 回傳狀態</small><strong>${escape(o.status || '未提供')}</strong></div><div class="metric"><small>預計交車區間</small><strong>${escape(o.deliveryWindow || o.deliveryDate || '未提供')}</strong></div><div class="metric"><small>車身號碼 VIN</small><strong class="vin">${escape(o.vin || '尚未提供')}</strong></div></div>${vin ? `<div class="vin-details">工廠字碼對照：${escape(vin.factory)} · 年式字碼：${escape(vin.year)}<br>${escape(vin.note)}</div>` : ''}${o.configuration ? `<p class="muted">配置：${escape(o.configuration)}</p>` : ''}</article>`;
  }).join('') : `<div class="empty"><h3>${state.connected ? '目前沒有已同步的有效訂單' : '先把你的訂單連接進來'}</h3><p>${state.connected ? '若剛完成授權，請確認同步結果與 Tesla 帳號。' : '至「連線設定」完成官方授權，即可開始累積交車紀錄。'}</p></div>`;
  $('history-list').innerHTML = state.history.length ? state.history.map(e => `<article class="event"><time>${escape(fmt(e.at))} · ${escape(e.orderId)}</time>${e.changes.map(c => `<p>${escape(labels[c.field] || c.field)}：<del>${escape(c.old || '未提供')}</del> → ${escape(c.new || '未提供')}</p>`).join('')}</article>`).join('') : '<div class="empty"><h3>還沒有變更紀錄</h3><p>同步後若 VIN、交期或配置改變，會在這裡留下新舊值。</p></div>';
  const newest = state.history[0]?.id || 0;
  if (latestEvent !== null && newest > latestEvent && 'Notification' in window && Notification.permission === 'granted') { try { new Notification('Tesla 訂單有新變更', {body:'請回到交車日誌查看詳細紀錄。'}); } catch { /* Some mobile browsers require service-worker notifications. History remains available. */ } }
  latestEvent = newest;
  $('check-order').innerHTML = '<option value="personal">一般交車檢查</option>' + state.orders.map(o=>`<option value="${escape(o.id)}">${escape(o.id)} · ${escape(o.model || 'Tesla')}</option>`).join('');
  $('check-order').value = checkId || 'personal'; if (!$('check-order').value) $('check-order').value = 'personal';
  renderChecks();
}
function renderChecks() {
  checkId = $('check-order').value || 'personal';
  const data = Object.hasOwn(checks, checkId) ? checks[checkId] : {};
  $('check-items').innerHTML = items.map(([id,title,desc]) => `<div class="check-row"><label><input type="checkbox" data-check="${id}" ${data[id]?.done ? 'checked' : ''}>${title}</label><p>${desc}</p><textarea aria-label="${title}備註" data-note="${id}" placeholder="備註或待處理事項">${escape(data[id]?.note || '')}</textarea></div>`).join('');
  progress();
}
function progress() { const data = Object.hasOwn(checks,checkId) ? checks[checkId] : {}; $('progress').textContent = `${items.filter(([id])=>data[id]?.done).length} / ${items.length} 已檢查`; }
function saveCheck(event) {
  const id = event.target.dataset.check || event.target.dataset.note; if (!id) return;
  if (!Object.hasOwn(checks,checkId)) Object.defineProperty(checks,checkId,{value:{},enumerable:true,writable:true});
  const old = checks[checkId][id] || {}; checks[checkId][id] = {...old, ...(event.target.dataset.check ? {done:event.target.checked} : {note:event.target.value.slice(0,4000)})};
  try { localStorage.setItem(localKey,JSON.stringify(checks)); } catch {message('瀏覽器無法儲存檢查紀錄，請匯出備份。');} progress();
}
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click',()=>{
  document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-selected',String(b===button)));
  document.querySelectorAll('.tab').forEach(s=>s.hidden=s.id!==button.dataset.tab);
}));
$('check-order').addEventListener('change',renderChecks); $('check-items').addEventListener('input',saveCheck);
$('export').addEventListener('click',()=>{
  const blob = new Blob([JSON.stringify({exportedAt:new Date().toISOString(),checks},null,2)],{type:'application/json'});
  const link = document.createElement('a'); link.href=URL.createObjectURL(blob);link.download='tesla-delivery-checks.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
});
async function refresh() { if (fetching || document.hidden) return; fetching=true;try {render(await api('state'));}catch(e){message(e.message);}finally{fetching=false;} }
async function action(button, callback) { button.disabled=true;message('');try{await callback();}catch(e){message(e.message);}finally{button.disabled=false;} }
$('login-form').addEventListener('submit',event=>{event.preventDefault();action(event.submitter,async()=>{await api('login',{password:$('password').value});$('password').value='';await refresh();});});
$('register').addEventListener('click',event=>action(event.target,async()=>{await api('register',{});await refresh();message('Tesla 區域註冊完成，接著可進行官方授權。');}));
$('sync').addEventListener('click',event=>action(event.target,async()=>{render(await api('sync',{}));message('訂單同步完成。');}));
$('disconnect').addEventListener('click',event=>action(event.target,async()=>{await api('disconnect',{});await refresh();message('已中斷 Tesla 背景同步。');}));
$('logout').addEventListener('click',event=>action(event.target,async()=>{await api('logout',{});location.reload();}));
$('notify').addEventListener('click',event=>action(event.target,async()=>{if(!('Notification' in window))return message('此瀏覽器不支援通知；仍可在變更紀錄查看更新。');const p=await Notification.requestPermission();message(p==='granted'?'已啟用網頁開啟期間通知。':'未允許通知，變更紀錄仍會持續儲存。');}));
$('backend-form').addEventListener('submit',event=>{event.preventDefault();try{const u=new URL($('backend-url').value);if(u.protocol!=='https:'||u.username||u.password)throw new Error();location.assign(u.origin);}catch{message('請輸入有效的 HTTPS 服務網址。');}});
if (location.hostname.endsWith('github.io')) { $('setup').hidden=false; }
else { await refresh();setInterval(refresh,60000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();}); }
if (new URLSearchParams(location.search).get('auth')==='cancelled') {message('已取消 Tesla 授權，可以稍後重新連接。');history.replaceState(null,'',location.pathname);}
