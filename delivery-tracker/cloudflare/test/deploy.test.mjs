import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,statSync} from 'node:fs';
import {deploy} from '../deploy.mjs';
const env={APP_PASSWORD:'test-password-at-least-16',DATA_KEY:'ab'.repeat(32),PUBLIC_URL:'https://delivery.example.workers.dev',UNRELATED_SECRET:'never-copy-this'};
test('deploy passes only the three requested values through a private temporary file',()=>{
  let file;
  deploy(env,(command,args,options)=>{
    assert.equal(command,'npx');assert.ok(args.includes('--secrets-file'));file=args.at(-1);
    assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{APP_PASSWORD:env.APP_PASSWORD,DATA_KEY:env.DATA_KEY,PUBLIC_URL:env.PUBLIC_URL});
    assert.equal(statSync(file).mode&0o777,0o600);
    assert.ok(!args.join(' ').includes(env.APP_PASSWORD));assert.ok(!args.join(' ').includes(env.DATA_KEY));
    assert.equal(options.stdio,'inherit');assert.ok(options.cwd.endsWith('/cloudflare'));
    return {status:0};
  });
  assert.equal(existsSync(file),false);
});
test('temporary secrets are cleaned after failed or interrupted deploy',()=>{
  for(const result of [{status:1},{status:null,signal:'SIGTERM'},{error:new Error('test')}]) {
    let file;assert.throws(()=>deploy(env,(_,args)=>{file=args.at(-1);return result;}));assert.equal(existsSync(file),false);
  }
});
test('missing or invalid build settings fail before a deployment starts',()=>{
  let called=false;
  for(const settings of [{},{...env,DATA_KEY:'bad'},{...env,APP_PASSWORD:'short'},{...env,PUBLIC_URL:'http://example.com'},{...env,PUBLIC_URL:'https://example.com/path'}]) {
    assert.throws(()=>deploy(settings,()=>{called=true;}));
  }
  assert.equal(called,false);
});
