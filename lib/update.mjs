// Actualización de Mixto desde la propia app: mira la versión publicada en GitHub, descarga el zip de la rama
// principal, sustituye los archivos de la instalación y deja al servidor reiniciarse. Nunca toca data,
// .runtime, node_modules ni .git, así que las conversaciones, la memoria y las herramientas descargadas se conservan.
import fs from 'node:fs';
import path from 'node:path';
import {extractZip} from './zip.mjs';

export const REPO='manuelfdezo/mixto';
export const PROTECTED=new Set(['data','.runtime','node_modules','.git']);

export function updateSources(env=process.env){
  const base=String(env.MIXTO_UPDATE_BASE||`https://raw.githubusercontent.com/${REPO}/main/`).replace(/\/?$/,'/');
  return {
    manifestUrl:base+'package.json',
    zipUrl:env.MIXTO_UPDATE_ZIP||`https://github.com/${REPO}/archive/refs/heads/main.zip`,
    pageUrl:`https://github.com/${REPO}`,
    enabled:env.MIXTO_UPDATE_CHECK!=='off'
  };
}

export function compareVersions(a,b){
  const parse=value=>String(value||'0').split('.').map(part=>parseInt(part,10)||0);
  const [x,y]=[parse(a),parse(b)];
  for(let i=0;i<Math.max(x.length,y.length);i++){const d=(x[i]||0)-(y[i]||0);if(d)return d<0?-1:1;}
  return 0;
}

export async function checkUpdate({current,sources,fetchImpl=fetch}){
  const response=await fetchImpl(sources.manifestUrl,{signal:AbortSignal.timeout(15000),headers:{'Cache-Control':'no-cache'}});
  if(!response.ok)throw new Error(`GitHub respondió ${response.status}.`);
  const manifest=await response.json();
  if(manifest?.name!=='mixto'||typeof manifest.version!=='string')throw new Error('La respuesta no es la versión de Mixto.');
  return {latest:manifest.version,available:compareVersions(manifest.version,current)>0};
}

// La carpeta con package.json y server.mjs dentro de lo extraído: GitHub envuelve el zip en «mixto-main/».
export function extractedRoot(dir){
  const isApp=candidate=>fs.existsSync(path.join(candidate,'package.json'))&&fs.existsSync(path.join(candidate,'server.mjs'));
  if(isApp(dir))return dir;
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(entry.isDirectory()&&isApp(path.join(dir,entry.name)))return path.join(dir,entry.name);
  }
  throw new Error('La descarga no contiene Mixto.');
}

export async function downloadUpdate({sources,into,fetchImpl=fetch,maxBytes=60*1024*1024}){
  const response=await fetchImpl(sources.zipUrl,{signal:AbortSignal.timeout(180000)});
  if(!response.ok)throw new Error(`La descarga respondió ${response.status}.`);
  const buffer=Buffer.from(await response.arrayBuffer());
  if(buffer.length>maxBytes)throw new Error('La descarga es demasiado grande.');
  const entries=extractZip(buffer);
  const dir=path.join(into,'update-'+Date.now());
  fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});
  for(const entry of entries){
    const full=path.join(dir,entry.name);
    if(entry.dir){fs.mkdirSync(full,{recursive:true});continue;}
    fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,entry.data);
  }
  return {dir,sourceDir:extractedRoot(dir)};
}

export function listFiles(dir,relative=''){
  const out=[];
  for(const entry of fs.readdirSync(path.join(dir,relative),{withFileTypes:true})){
    if(!relative&&PROTECTED.has(entry.name))continue;
    const rel=relative?relative+'/'+entry.name:entry.name;
    if(entry.isDirectory())out.push(...listFiles(dir,rel));
    else if(entry.isFile())out.push(rel);
  }
  return out.sort();
}

export function readManifest(file){
  try{const manifest=JSON.parse(fs.readFileSync(file,'utf8'));return Array.isArray(manifest.files)?manifest.files.filter(entry=>typeof entry==='string'):[];}
  catch{return [];}
}

// Copia la versión nueva sobre la instalación: sustituye y añade archivos, retira los que instaló la versión
// anterior y ya no existen, y guarda una copia de lo que cambia. Devuelve qué hizo.
export function applyUpdate({root,sourceDir,manifestFile,backupDir}){
  const manifest=JSON.parse(fs.readFileSync(path.join(sourceDir,'package.json'),'utf8'));
  if(manifest.name!=='mixto'||typeof manifest.version!=='string')throw new Error('La descarga no es Mixto.');
  const files=listFiles(sourceDir);
  if(!files.includes('server.mjs'))throw new Error('La descarga no contiene el servidor de Mixto.');
  const previous=readManifest(manifestFile);
  const target=rel=>{
    const parts=rel.split('/');
    if(PROTECTED.has(parts[0])||parts.includes('..')||parts.includes(''))throw new Error('Ruta no permitida: '+rel);
    return path.join(root,rel);
  };
  const keep=(rel,current)=>{if(!backupDir)return;const backup=path.join(backupDir,rel);fs.mkdirSync(path.dirname(backup),{recursive:true});fs.writeFileSync(backup,current);};
  let copied=0,removed=0;
  for(const rel of files){
    const destination=target(rel),data=fs.readFileSync(path.join(sourceDir,rel));
    if(fs.existsSync(destination)){
      const current=fs.readFileSync(destination);
      if(current.equals(data))continue;
      keep(rel,current);
    }
    fs.mkdirSync(path.dirname(destination),{recursive:true});
    const temp=destination+'.mixto-nuevo';
    fs.writeFileSync(temp,data);fs.renameSync(temp,destination);copied++;
  }
  const wanted=new Set(files);
  for(const rel of previous){
    if(wanted.has(rel))continue;
    let destination;try{destination=target(rel);}catch{continue;}
    if(!fs.existsSync(destination))continue;
    keep(rel,fs.readFileSync(destination));fs.rmSync(destination,{force:true});removed++;
  }
  fs.mkdirSync(path.dirname(manifestFile),{recursive:true});
  fs.writeFileSync(manifestFile,JSON.stringify({version:manifest.version,files,updatedAt:new Date().toISOString()},null,2));
  return {version:manifest.version,copied,removed};
}
