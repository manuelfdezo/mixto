import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const url='http://127.0.0.1:4317';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function health(){try{const h=await(await fetch(url+'/api/health',{signal:AbortSignal.timeout(1500)})).json();return h.app==='mixto'?h:null;}catch{return null;}}
async function ready(){return !!(await health());}
const local=(()=>{try{return JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version||null;}catch{return null;}})();
function open(){if(process.argv.includes('--no-browser'))return;const child=spawn('explorer.exe',[url],{windowsHide:true,detached:true,stdio:'ignore'});child.on('error',()=>console.log('Abre '+url+' en tu navegador.'));child.unref();}
const running=await health();
let replaced=false;
if(running){
  if(!local||running.version===local){open();console.log('Mixto ya está abierto: '+url);process.exit(0);}
  // Los archivos son de otra versión: el servidor abierto se cierra y arranca el nuevo.
  console.log(`Mixto ${running.version} sigue abierto; se cierra para arrancar la versión ${local}.`);
  try{const page=await fetch(url+'/');const cookie=(page.headers.get('set-cookie')||'').split(';')[0];await fetch(url+'/api/shutdown',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-Mixto-Client':'1'},body:'{}'});}catch{}
  for(let n=0;n<60&&await ready();n++)await pause(250);
  replaced=true;
}
const runtime=path.join(root,'.runtime');fs.mkdirSync(runtime,{recursive:true});
const stdout=fs.openSync(path.join(runtime,'server.log'),'a');const stderr=fs.openSync(path.join(runtime,'server-error.log'),'a');
const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,detached:true,stdio:['ignore',stdout,stderr],env:{...process.env,...(replaced?{MIXTO_RESTART:'1'}:{})}});
child.on('error',e=>console.error(e.message));child.unref();fs.closeSync(stdout);fs.closeSync(stderr);
for(let n=0;n<35;n++){if(await ready()){open();console.log('Mixto abierto: '+url);process.exit(0);}await pause(300);}
console.error('No se pudo abrir Mixto. Revisa .runtime/server-error.log.');process.exit(1);
