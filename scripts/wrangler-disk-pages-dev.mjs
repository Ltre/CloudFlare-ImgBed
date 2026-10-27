/**
 * Pages CLI does not accept a custom --config file path.
 * Safely install and remove the isolated test config on Ctrl+C/exit.
 */
import {access,copyFile,unlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
const destination=resolve('wrangler.jsonc');
let exists=false;
try{await access(destination);exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
if(exists)throw new Error('wrangler.jsonc already exists; refusing to overwrite the user configuration.');
await copyFile('wrangler.disk-local.jsonc',destination);
const bin=resolve('node_modules','.bin',process.platform==='win32'?'wrangler.cmd':'wrangler');
const child=spawn(bin,['pages','dev','frontend-dist','--persist-to','.wrangler/disk-dev-state'],{
  cwd:process.cwd(),stdio:'inherit',shell:process.platform==='win32'});
let done=false;
async function cleanup(){if(done)return;done=true;try{await unlink(destination);}catch(e){console.error(e);}}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{child.kill(signal);});
child.once('error',async error=>{console.error(error);await cleanup();process.exitCode=1;});
child.once('exit',async (code)=>{await cleanup();process.exitCode=code||0;});
