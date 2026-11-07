// No inference about production, shipping or delivery from VIN presence alone.
export function normalizeOrders(payload) {
  const rows = payload?.response;
  if (!Array.isArray(rows)) throw new Error('Tesla 訂單回應格式不符，保留上次資料。');
  const text = v => typeof v === 'string' ? v.slice(0, 500) : '';
  const seen = new Set();
  return rows.map(row => {
    const id = text(row.referenceNumber) || text(row.orderReferenceNumber) || (row.id == null ? '' : String(row.id));
    if (!id || seen.has(id)) throw new Error('Tesla 訂單編號遺漏或重複，保留上次資料。');
    seen.add(id);
    return { id, model: text(row.modelName) || text(row.modelCode) || text(row.model), vin: text(row.vin),
      status: text(row.orderStatus) || text(row.status), deliveryWindow: text(row.deliveryWindow),
      deliveryDate: text(row.deliveryDate), configuration: text(row.trimName) || text(row.trim),
      source: 'Tesla Fleet API /users/orders' };
  });
}
export function changes(previous, next) {
  if (!previous) return [];
  return ['vin', 'status', 'deliveryWindow', 'deliveryDate', 'configuration', 'model']
    .filter(key => previous[key] !== next[key])
    .map(field => ({ field, old: previous[field] || '', new: next[field] || '' }));
}
export function vinBasics(value) {
  const vin = String(value || '').trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return null;
  const factories = { B: '柏林', C: '上海', F: 'Fremont', A: 'Austin', N: 'Reno' };
  const codes = 'ABCDEFGHJKLMNPRSTVWXY123456789';
  const offset = codes.indexOf(vin[9]);
  return { vin, factory: factories[vin[10]] || '尚無對照資料',
    year: offset < 0 ? '未知' : `${1980 + offset}／${2010 + offset}（30 年循環，須核對文件）`,
    note: '僅基本字碼對照，非 Tesla 規格認證；電池、馬達、螢幕、內裝需官方資料。' };
}
