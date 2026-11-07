import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

// Explicit opt-in deploy entry point for settings already saved in Workers
// Builds. No secret values are embedded in source, argv, or console messages.
export function deploy(env=process.env,run=spawnSync) {
  const names=['APP_PASSWORD','DATA_KEY','PUBLIC_URL'];
  const missing=names.filter(k=>typeof env[k]!=='string'||!env[k]);
  if(missing.length)throw new Error('組建環境缺少設定：'+missing.join('、')+'。請填入原本保存的值，不要重新產生 DATA_KEY。');
  if(env.APP_PASSWORD.length<16)throw new Error('APP_PASSWORD 必須至少 16 字元。');
  if(!/^[a-f0-9]{64}$/i.test(env.DATA_KEY))throw new Error('DATA_KEY 必須是 64 位十六進位字串。');
  try {
    const u=new URL(env.PUBLIC_URL);
    if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error();
  } catch {throw new Error('PUBLIC_URL 必須是完整 HTTPS origin，不可包含額外路徑。');}
  const directory=mkdtempSync(join(tmpdir(),'tesla-deploy-'));
  const file=join(directory,'runtime-secrets.json');
  try {
    writeFileSync(file,JSON.stringify(Object.fromEntries(names.map(k=>[k,env[k]]))),{mode:0o600});
    const result=run('npx',['--yes','wrangler@4.158.0','deploy','--secrets-file',file],{
      cwd:dirname(fileURLToPath(import.meta.url)),stdio:'inherit',env
    });
    if(result.error||result.signal||result.status!==0)throw new Error('部署未完成，請查看上方 Wrangler 日誌；不要公開含密鑰的設定內容。');
  } finally {rmSync(directory,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {deploy();}catch(e){console.error(e.message);process.exitCode=1;}
}
