const encoder = new TextEncoder();
export const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('');
export async function hash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), x => x.toString(16).padStart(2, '0')).join('');
}
export async function equalSecret(a, b) {
  const x = await hash(a), y = await hash(b);
  let mismatch = 0; for (let i=0; i<x.length; i++) mismatch |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return mismatch === 0;
}
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
async function aes(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex || '')) throw new Error('Invalid encryption key');
  return crypto.subtle.importKey('raw', Uint8Array.from(hex.match(/../g), p => parseInt(p,16)), 'AES-GCM', false, ['encrypt','decrypt']);
}
export async function seal(value, hex) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},await aes(hex),encoder.encode(JSON.stringify(value)));
  return {iv:b64(iv),ciphertext:b64(ciphertext)};
}
export async function unseal(value, hex) {
  const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(value.iv)},await aes(hex),unb64(value.ciphertext));
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function domainKeys(hex) {
  const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const pub=b64(await crypto.subtle.exportKey('spki',keys.publicKey));
  const privateKey=await seal(b64(await crypto.subtle.exportKey('pkcs8',keys.privateKey)),hex);
  return {publicKey:'-----BEGIN PUBLIC KEY-----\n'+pub.match(/.{1,64}/g).join('\n')+'\n-----END PUBLIC KEY-----\n',privateKey};
}
