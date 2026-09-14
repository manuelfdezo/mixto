import fs from 'node:fs';
import path from 'node:path';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';

const run=promisify(execFile);
const MAX_BUFFER=1024*1024*64;
const MAX_CARRIED_BYTES=2*1024*1024;
const DEFAULT_SHARED=['node_modules'];
const DEFAULT_IGNORED=['.atl'];
// The user's own git identity may be unset; never let that break an internal baseline commit.
const IDENTITY=['-c','user.name=Mixto','-c','user.email=mixto@localhost'];

const gitSync=(cwd,args)=>execFileSync('git',['-C',cwd,...args],{windowsHide:true,encoding:'utf8',maxBuffer:MAX_BUFFER});
const git=async(cwd,args)=>(await run('git',['-C',cwd,...args],{windowsHide:true,maxBuffer:MAX_BUFFER})).stdout;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const slug=value=>String(value||'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,12)||'run';
const lines=value=>String(value||'').split('\n').map(line=>line.trim()).filter(Boolean);
const reasonOf=error=>String(error?.stderr||error?.message||'').trim().slice(0,500);
const norm=value=>String(value||'').replace(/\\/g,'/').toLocaleLowerCase();

// Rutas relativas al repo que son ruido propio de las herramientas del agente, nunca trabajo real
// de la sub-tarea. `MIXTO_PATCH_EXCLUDE` permite sumar más rutas separadas por comas.
export function ignoredPaths() {
  const extra=String(process.env.MIXTO_PATCH_EXCLUDE||'').split(',').map(entry=>entry.trim()).filter(Boolean);
  return [...DEFAULT_IGNORED,...extra];
}

export function isIgnored(file) {
  const target=norm(file);
  return ignoredPaths().some(entry=>{
    const pattern=norm(entry).replace(/\/+$/,'');
    if(!pattern)return false;
    return target===pattern||target.startsWith(pattern+'/');
  });
}

function statusPaths(output) {
  return lines(output).map(line=>{
    const entry=line.slice(2).trim();
    const renamed=entry.split(' -> ');
    return (renamed[renamed.length-1]||'').replace(/^"|"$/g,'');
  }).filter(Boolean);
}

export function inspect(projectPath) {
  const absent=reason=>({kind:'shared',toplevel:null,relative:'',head:null,dirtyTracked:[],untracked:[],reason});
  let toplevel;
  try {toplevel=fs.realpathSync(gitSync(projectPath,['rev-parse','--show-toplevel']).trim());}
  catch {return absent('Esta carpeta no es un repositorio git.');}
  let head;
  // A repository without commits has nothing to base an isolated copy on.
  try {head=gitSync(toplevel,['rev-parse','HEAD']).trim();}
  catch {return absent('El repositorio todavía no tiene ningún commit.');}
  return {
    kind:'worktree',toplevel,head,
    relative:path.relative(toplevel,fs.realpathSync(projectPath)).split(path.sep).join('/'),
    dirtyTracked:statusPaths(gitSync(toplevel,['status','--porcelain','--untracked-files=no'])),
    untracked:lines(gitSync(toplevel,['ls-files','--others','--exclude-standard'])),
    reason:''
  };
}

// Only ever called after the user explicitly chooses it: this changes the shape of their folder.
export async function initRepository(projectPath) {
  await run('git',['-C',projectPath,'init','-b','main'],{windowsHide:true,maxBuffer:MAX_BUFFER});
  await run('git',['-C',projectPath,'add','-A','.'],{windowsHide:true,maxBuffer:MAX_BUFFER});
  await run('git',['-C',projectPath,...IDENTITY,'commit','--allow-empty','--no-verify','-m','mixto: punto de partida'],{windowsHide:true,maxBuffer:MAX_BUFFER});
}

// `stash create` records the dirty tracked state as a commit without touching the working tree, so a
// copy (or a later diff) can start from exactly what the user sees now, uncommitted work included.
function baseOf(info,warnings) {
  if(!info.dirtyTracked.length)return info.head;
  const stashed=gitSync(info.toplevel,['stash','create']).trim();
  if(stashed)return stashed;
  warnings?.push('No se pudo incluir el trabajo sin guardar en las copias aisladas; los agentes parten del último commit.');
  return info.head;
}

function carryUntracked(info,worktreeRoot,warnings) {
  for(const relative of info.untracked) {
    const source=path.join(info.toplevel,relative),target=path.join(worktreeRoot,relative);
    let size;
    try {size=fs.statSync(source).size;} catch {continue;}
    if(size>MAX_CARRIED_BYTES) {warnings.push(`«${relative}» no se copió a las copias aisladas por tamaño; los agentes no lo verán.`);continue;}
    try {fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);}
    catch {warnings.push(`No se pudo copiar «${relative}» a las copias aisladas.`);}
  }
}

function linkShared(info,worktreeRoot,sharedPaths,warnings) {
  for(const name of sharedPaths) {
    const source=path.join(info.toplevel,name),target=path.join(worktreeRoot,name);
    if(!fs.existsSync(source)||fs.existsSync(target))continue;
    try {fs.symlinkSync(source,target,'junction');}
    catch {warnings.push(`No se pudo compartir «${name}» con las copias aisladas; un agente que ejecute comandos puede fallar por eso.`);}
  }
}

// Una copia aislada: worktree en `base`, archivos sin seguimiento copiados y todo ello como commit de
// partida, para que el parche de la sub-tarea contenga únicamente su propio trabajo.
async function addWorkspace(info,base,worktreeRoot,sharedPaths,warnings) {
  await git(info.toplevel,['worktree','add','--detach',worktreeRoot,base]);
  carryUntracked(info,worktreeRoot,warnings);
  if(lines(await git(worktreeRoot,['status','--porcelain'])).length) {
    await git(worktreeRoot,['add','-A','.']);
    await run('git',['-C',worktreeRoot,...IDENTITY,'commit','--no-verify','-m','mixto: estado inicial'],{windowsHide:true,maxBuffer:MAX_BUFFER});
  }
  linkShared(info,worktreeRoot,sharedPaths,warnings);
  const cwd=info.relative?path.join(worktreeRoot,info.relative):worktreeRoot;
  fs.mkdirSync(cwd,{recursive:true});
  return cwd;
}

export async function createWorkspaces({projectPath,dataDir,runId,indexes,sharedPaths=DEFAULT_SHARED}) {
  const info=inspect(projectPath);
  if(info.kind!=='worktree')throw new Error('Esta carpeta no admite copias aisladas: '+info.reason);
  const warnings=[];
  const base=baseOf(info,warnings);
  const root=path.join(dataDir,'wt',slug(runId));
  fs.mkdirSync(root,{recursive:true});
  const roots=new Map(),cwds=new Map();
  for(const index of indexes) {
    const worktreeRoot=path.join(root,String(index));
    const cwd=await addWorkspace(info,base,worktreeRoot,sharedPaths,warnings);
    roots.set(index,worktreeRoot);cwds.set(index,cwd);
  }
  return {base,roots,cwds,warnings};
}

// Una copia más, con todos los parches aplicados en orden, para que el revisor juzgue el resultado
// integrado y pueda ejecutar comprobaciones sin tocar el proyecto real.
export async function createReviewWorkspace({projectPath,dataDir,runId,base,patches,sharedPaths=DEFAULT_SHARED}) {
  const info=inspect(projectPath);
  if(info.kind!=='worktree')throw new Error('Esta carpeta no admite copias aisladas: '+info.reason);
  const warnings=[];
  const worktreeRoot=path.join(dataDir,'wt',slug(runId),'review');
  if(fs.existsSync(worktreeRoot))await discard(info.toplevel,worktreeRoot,sharedPaths);
  fs.mkdirSync(path.dirname(worktreeRoot),{recursive:true});
  const cwd=await addWorkspace(info,base||info.head,worktreeRoot,sharedPaths,warnings);
  try {
    for(const patch of (patches||[]).filter(patch=>patch?.file))await git(worktreeRoot,['apply',patch.file]);
  } catch(error) {
    await discard(info.toplevel,worktreeRoot,sharedPaths);
    throw new Error('No se pudo preparar la copia de revisión: '+reasonOf(error));
  }
  return {root:worktreeRoot,cwd,warnings};
}

function countNumstat(numstat) {
  let insertions=0,deletions=0,files=0;
  for(const line of lines(numstat)) {
    const [added,removed]=line.split('\t');
    files++;
    if(added!=='-')insertions+=Number(added)||0;
    if(removed!=='-')deletions+=Number(removed)||0;
  }
  return {files,insertions,deletions};
}

export async function capturePatch({worktreeRoot,patchPath}) {
  await git(worktreeRoot,['add','-A','.']);
  // Ruido propio del agente (p.ej. `.atl`) nunca debe aparecer en el parche de una sub-tarea.
  const exclude=ignoredPaths().map(entry=>`:(exclude)${entry}`);
  const numstat=(await git(worktreeRoot,['diff','--numstat','HEAD','--',...exclude])).trim();
  if(!numstat)return null;
  const diff=await git(worktreeRoot,['diff','--binary','HEAD','--',...exclude]);
  if(!diff.trim())return null;
  fs.mkdirSync(path.dirname(patchPath),{recursive:true});
  fs.writeFileSync(patchPath,diff);
  return {file:patchPath,...countNumstat(numstat)};
}

// Punto de partida de un escritor que trabaja en la carpeta real: lo que cambie desde aquí es su obra.
export function snapshotProject(projectPath) {
  const info=inspect(projectPath);
  if(info.kind!=='worktree')return null;
  return {base:baseOf(info),toplevel:info.toplevel,untracked:info.untracked};
}

// El diff desde la instantánea, sin tocar el índice del usuario. Los archivos nuevos no tienen diff en
// git sin registrarlos, así que se listan aparte para que el revisor los lea.
export async function diffSince({projectPath,snapshot,patchPath}) {
  if(!snapshot?.base)return null;
  const exclude=ignoredPaths().map(entry=>`:(exclude)${entry}`);
  let numstat,diff,others;
  try {
    numstat=(await git(snapshot.toplevel,['diff','--numstat',snapshot.base,'--',...exclude])).trim();
    diff=await git(snapshot.toplevel,['diff','--binary',snapshot.base,'--',...exclude]);
    others=lines(await git(snapshot.toplevel,['ls-files','--others','--exclude-standard']));
  } catch {return null;}
  const before=new Set(snapshot.untracked||[]);
  const created=others.filter(file=>!before.has(file)&&!isIgnored(file));
  if(!numstat&&!created.length)return null;
  fs.mkdirSync(path.dirname(patchPath),{recursive:true});
  fs.writeFileSync(patchPath,diff);
  const counted=countNumstat(numstat);
  return {file:patchPath,files:counted.files+created.length,insertions:counted.insertions,deletions:counted.deletions,created};
}

export async function patchFiles({projectPath,patchFile}) {
  const output=await git(projectPath,['apply','--numstat',patchFile]);
  return lines(output).map(line=>line.split('\t')[2]).filter(Boolean);
}

// `git apply --check` judges each patch against the tree as it is now, never as a series, so two
// sub-tasks touching one file both pass and only the second fails for real. Overlaps are caught here.
export async function checkPatches({projectPath,patches}) {
  const list=(patches||[]).filter(patch=>patch?.file);
  if(!list.length)return {ok:true,failures:[],overlaps:[]};
  const failures=[],owners=new Map(),overlaps=new Set();
  for(const patch of list) {
    let touched=[];
    try {touched=await patchFiles({projectPath,patchFile:patch.file});}
    catch(error) {failures.push({file:patch.file,reason:reasonOf(error)});continue;}
    for(const file of touched) {
      if(owners.has(file)&&owners.get(file)!==patch.file)overlaps.add(file);
      else owners.set(file,patch.file);
    }
    try {await git(projectPath,['apply','--check',patch.file]);}
    catch(error) {failures.push({file:patch.file,reason:reasonOf(error)});}
  }
  const ok=!failures.length&&!overlaps.size;
  if(overlaps.size)failures.push({file:[...overlaps].join(', '),
    reason:'Más de una sub-tarea modificó este archivo; hay que decidir a mano qué versión vale.'});
  return {ok,failures,overlaps:[...overlaps]};
}

export async function applyPatches({projectPath,patches}) {
  const list=(patches||[]).filter(patch=>patch?.file);
  if(!list.length)return {applied:[],conflicts:[]};
  const verified=await checkPatches({projectPath,patches});
  if(!verified.ok)return {applied:[],conflicts:verified.failures};
  const applied=[];
  for(const patch of list) {
    try {await git(projectPath,['apply',patch.file]);applied.push(patch.file);}
    catch(error) {
      // All or nothing: undo what already landed so the project never stays half-integrated.
      for(const done of [...applied].reverse()) {try {await git(projectPath,['apply','-R',done]);} catch {}}
      return {applied:[],conflicts:[{file:patch.file,reason:reasonOf(error)}]};
    }
  }
  return {applied,conflicts:[]};
}

function unlinkShared(worktreeRoot,sharedPaths) {
  for(const name of sharedPaths) {
    const target=path.join(worktreeRoot,name);
    let stats;
    try {stats=fs.lstatSync(target);} catch {continue;}
    if(!stats.isSymbolicLink())continue;
    // Remove the link itself; a recursive delete here would reach into the real project folder.
    try {fs.rmdirSync(target);} catch {try{fs.unlinkSync(target);}catch{}}
  }
}

async function discard(toplevel,worktreeRoot,sharedPaths) {
  unlinkShared(worktreeRoot,sharedPaths);
  for(let attempt=0;attempt<4;attempt++) {
    try {if(toplevel)await git(toplevel,['worktree','remove','--force',worktreeRoot]);return;}
    catch {await delay(150*(attempt+1));}
  }
  // On Windows a just-killed agent can hold a handle for a moment; fall back to removing the folder.
  try {fs.rmSync(worktreeRoot,{recursive:true,force:true});} catch {}
}

// Retira una sola copia de la tarea (p. ej. la de revisión) y deja las demás en su sitio.
export async function removeWorkspace({projectPath,dataDir,runId,name,sharedPaths=DEFAULT_SHARED}) {
  const worktreeRoot=path.join(dataDir,'wt',slug(runId),String(name));
  if(!fs.existsSync(worktreeRoot))return;
  let toplevel=null;
  try {toplevel=inspect(projectPath).toplevel;} catch {}
  await discard(toplevel,worktreeRoot,sharedPaths);
  if(toplevel) {try {await git(toplevel,['worktree','prune','--expire=now']);} catch {}}
}

export async function removeWorkspaces({projectPath,dataDir,runId,sharedPaths=DEFAULT_SHARED}) {
  const root=path.join(dataDir,'wt',slug(runId));
  let toplevel=null;
  try {toplevel=inspect(projectPath).toplevel;} catch {}
  let entries=[];
  try {entries=fs.readdirSync(root);} catch {return;}
  for(const entry of entries)await discard(toplevel,path.join(root,entry),sharedPaths);
  try {fs.rmSync(root,{recursive:true,force:true});} catch {}
  // Prune last: it only clears a registration once that folder is actually gone.
  if(toplevel) {try {await git(toplevel,['worktree','prune','--expire=now']);} catch {}}
  try {fs.rmdirSync(path.dirname(root));} catch {}
}

export async function cleanupOrphanWorkspaces({dataDir,projectPaths=[],sharedPaths=DEFAULT_SHARED}) {
  const root=path.join(dataDir,'wt');
  let runs=[];
  try {runs=fs.readdirSync(root);} catch {return;}
  for(const name of runs) {
    const runRoot=path.join(root,name);
    let entries=[];
    try {entries=fs.readdirSync(runRoot);} catch {}
    for(const entry of entries)unlinkShared(path.join(runRoot,entry),sharedPaths);
    try {fs.rmSync(runRoot,{recursive:true,force:true});} catch {}
  }
  for(const projectPath of projectPaths) {try {await git(projectPath,['worktree','prune','--expire=now']);} catch {}}
  try {fs.rmSync(root,{recursive:true,force:true});} catch {}
}
