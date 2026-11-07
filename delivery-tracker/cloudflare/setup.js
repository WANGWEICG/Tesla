document.getElementById('public-url').value=location.origin;
document.getElementById('generate').addEventListener('click',()=>{
  const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
  document.getElementById('app-password').value=random();
  document.getElementById('data-key').value=random();
});
