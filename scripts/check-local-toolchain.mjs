/**
 * Preflight for Windows/Linux G1 tests, using installed dependencies only.
 * npm >= 12 blocks dependency install scripts unless allowScripts approves them.
 */
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const require=createRequire(import.meta.url);
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
let failures=0;
function check(label,callback) {
  try {
    const detail=callback();
    console.log('[OK] '+label+(detail?' — '+detail:''));
  }catch(error){
    failures++;
    console.error('[FAIL] '+label+': '+(error?.message||error));
  }
}
const version=process.versions.node;
console.log('Local toolchain · Node '+version+' · '+process.platform+'/'+process.arch);
if(Number(version.split('.')[0])!==22)
  console.warn('[WARN] The G1 GitHub Actions baseline is Node 22; for comparable results prefer Node.js 22 LTS.');

check('Mocha 8 executable',()=>{
  const path=resolve(root,'node_modules/mocha/bin/mocha');
  if(!existsSync(path))throw Error('missing node_modules/mocha/bin/mocha');
  return 'bin/mocha';
});
check('better-sqlite3 native binding',()=>{
  const Database=require('better-sqlite3');
  const db=new Database(':memory:');
  try{
    const row=db.prepare('SELECT 1 AS ok').get();
    if(row.ok!==1)throw Error('SQLite returned an unexpected value');
  }finally{db.close();}
  return 'in-memory SQLite query passed';
});
check('esbuild binary',()=>{
  const esbuild=require('esbuild');
  const output=esbuild.transformSync('const a = 1;', {loader:'js'});
  if(!output.code.includes('const a'))throw Error('no transformed output');
  return esbuild.version;
});
check('workerd binary',()=>{
  const bin=resolve(root,'node_modules','.bin',process.platform==='win32'?'workerd.cmd':'workerd');
  if(!existsSync(bin))throw Error('missing '+bin);
  const result=spawnSync(bin,['--version'],{
    cwd:root,encoding:'utf8',shell:process.platform==='win32',
    windowsHide:true,timeout:15000
  });
  if(result.error)throw result.error;
  if(result.status!==0)throw Error('exit '+result.status+': '+String(result.stderr||result.stdout).slice(0,400));
  return String(result.stdout||result.stderr).trim().split('\n')[0];
});
if(failures){
  console.error('\n'+failures+' toolchain check(s) failed. Reinstall with the project allowScripts policy:');
  console.error('  npm ci');
  console.error('If a native binary still fails, use Node.js 22 LTS and retry npm ci.');
  process.exitCode=1;
}else console.log('Local G1 toolchain ready; proceed with npm test and npm run test:wrangler:local.');
