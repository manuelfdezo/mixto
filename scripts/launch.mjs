import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const url='http://127.0.0.1:4317';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function ready(){try{return (await(await fetch(url+'/api/health',{signal:AbortSignal.timeout(1500)})).json()).app==='mixto';}catch{return false;}}
function open(){if(process.argv.includes('--no-browser'))return;const child=spawn('explorer.exe',[url],{windowsHide:true,detached:true,stdio:'ignore'});child.on('error',()=>console.log('Abre '+url+' en tu navegador.'));child.unref();}
if(await ready()){open();console.log('Mixto ya está abierto: '+url);process.exit(0);}
const runtime=path.join(root,'.runtime');fs.mkdirSync(runtime,{recursive:true});
const stdout=fs.openSync(path.join(runtime,'server.log'),'a');const stderr=fs.openSync(path.join(runtime,'server-error.log'),'a');
const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,detached:true,stdio:['ignore',stdout,stderr]});
child.on('error',e=>console.error(e.message));child.unref();fs.closeSync(stdout);fs.closeSync(stderr);
for(let n=0;n<35;n++){if(await ready()){open();console.log('Mixto abierto: '+url);process.exit(0);}await pause(300);}
console.error('No se pudo abrir Mixto. Revisa .runtime/server-error.log.');process.exit(1);
