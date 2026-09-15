import fs from 'node:fs';
import path from 'node:path';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {inspect} from './isolation.mjs';

// Cooperación por git: el libro de encargos vive en una rama propia del repositorio del proyecto,
// `mixto-encargos`, gestionada desde una copia de trabajo oculta en la carpeta de datos de Mixto.
// Nunca toca las ramas de código ni empuja commits del usuario; cada Mixto que abra un clon del mismo
// repositorio lee la misma rama, sabe quién es por el correo de su git y comparte estado y notas.
const run=promisify(execFile);
const ENV={...process.env,GIT_TERMINAL_PROMPT:'0'};
const MAX_BUFFER=1024*1024*16;
const git=async(cwd,args,{timeout=20000}={})=>(await run('git',['-C',cwd,...args],{windowsHide:true,maxBuffer:MAX_BUFFER,env:ENV,timeout})).stdout;
const IDENTITY=['-c','user.name=Mixto','-c','user.email=mixto@localhost'];
export const LEDGER_BRANCH='mixto-encargos';
export const STATUSES=['pendiente','en-curso','hecha'];
export const shortId=id=>String(id||'').replace(/-/g,'').slice(0,8);
const oneLine=value=>String(value??'').replace(/\r?\n/g,' ').trim();
const reasonOf=error=>String(error?.stderr||error?.message||'').trim().slice(0,300);
const nowIso=()=>new Date().toISOString();
const README=`# Libro de encargos de Mixto

Cada archivo de \`encargos/\` es una parte de una tarea asignada a una persona del equipo. Para darla por hecha, cambia \`estado: hecha\` en su cabecera y añade una línea en «Notas», o incluye \`mixto:<id corto>\` (los ocho primeros caracteres del id) en el mensaje de un commit en cualquier rama. \`equipo.json\` es la lista de personas. Mixto mezcla los cambios por fecha y une las notas.
`;

// Un encargo se guarda con cabecera clave: valor y cuerpo en markdown: legible y editable por cualquiera.
export function serializeAssignment(a) {
  const head=[['id',a.id],['proyecto',a.project||''],['titulo',a.title],['asignado_a',a.personId||''],['asignado_nombre',a.personName||''],
    ['asignado_correo',a.personEmail||''],['estado',STATUSES.includes(a.status)?a.status:'pendiente'],['fecha_limite',a.due||''],
    ['creado_por',a.createdBy||''],['creado',a.createdAt||''],['actualizado',a.updatedAt||a.createdAt||''],['tarea',a.task||''],['origen',a.origin||''],
    ['commits',(a.commits||[]).join(' ')]];
  const lines=['---',...head.map(([key,value])=>`${key}: ${oneLine(value)}`),'---','',`# ${oneLine(a.title)}`,'',
    `Para darlo por hecho: cambia \`estado: hecha\` arriba y añade una nota, o incluye \`mixto:${shortId(a.id)}\` en el mensaje de un commit.`,'',
    '## Encargo','',String(a.instructions||'').trim(),''];
  if(a.scope?.length)lines.push('## Alcance','',...a.scope.map(entry=>`- ${oneLine(entry)}`),'');
  if(a.context)lines.push('## Contexto','',String(a.context).trim(),'');
  lines.push('## Notas','',...(a.notes||[]).map(note=>`- ${oneLine(note)}`),'');
  return lines.join('\n');
}

function sections(body) {
  const known=new Set(['Encargo','Alcance','Contexto','Notas']);
  const map={};let current=null;let buffer=[];
  for(const line of String(body||'').split(/\r?\n/)) {
    const heading=/^## (.+?)\s*$/.exec(line);
    if(heading&&known.has(heading[1])) {
      if(current)map[current]=buffer.join('\n').trim();
      current=heading[1];buffer=[];continue;
    }
    if(current)buffer.push(line);
  }
  if(current)map[current]=buffer.join('\n').trim();
  return map;
}

export function parseAssignment(text) {
  const match=/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text||''));
  if(!match)return null;
  const meta={};
  for(const line of match[1].split(/\r?\n/)) {
    const colon=line.indexOf(':');if(colon<0)continue;
    meta[line.slice(0,colon).trim()]=line.slice(colon+1).trim();
  }
  if(!meta.id||!meta.titulo)return null;
  const parts=sections(match[2]);
  const list=value=>String(value||'').split(/\r?\n/).map(line=>line.replace(/^[-*]\s*/,'').trim()).filter(Boolean);
  return {id:meta.id,project:meta.proyecto||'',title:meta.titulo,personId:meta.asignado_a||'',personName:meta.asignado_nombre||'',personEmail:meta.asignado_correo||'',
    status:STATUSES.includes(meta.estado)?meta.estado:'pendiente',due:meta.fecha_limite||null,createdBy:meta.creado_por||'',createdAt:meta.creado||'',
    updatedAt:meta.actualizado||meta.creado||'',task:meta.tarea||'',origin:meta.origen||'',
    commits:String(meta.commits||'').split(/[\s,]+/).filter(Boolean),
    instructions:parts.Encargo||'',scope:list(parts.Alcance),context:parts.Contexto||'',notes:list(parts.Notas)};
}

// Varias versiones del mismo encargo (local y remotas): manda la más reciente y las notas se unen.
export function mergeAssignments(versions) {
  const list=(versions||[]).filter(Boolean);
  if(!list.length)return null;
  const best={...list.reduce((winner,candidate)=>candidate.updatedAt>winner.updatedAt?candidate:winner)};
  best.notes=[...best.notes];best.commits=[...(best.commits||[])];
  for(const version of list) {
    for(const note of version.notes||[])if(!best.notes.includes(note))best.notes.push(note);
    for(const commit of version.commits||[])if(!best.commits.includes(commit))best.commits.push(commit);
  }
  best.scope=[...best.scope];
  return best;
}

export const serializeRoster=people=>JSON.stringify({personas:(people||[]).map(person=>({id:person.id,name:person.name,role:person.role||'',email:person.email||'',notes:person.notes||''}))},null,2)+'\n';
export function parseRoster(text) {
  try {
    const data=JSON.parse(String(text||'').replace(/^﻿/,''));
    return (Array.isArray(data?.personas)?data.personas:[]).filter(person=>person&&typeof person.id==='string'&&typeof person.name==='string'&&person.name.trim())
      .map(person=>({id:person.id,name:String(person.name).slice(0,80),role:String(person.role||'').slice(0,80),email:String(person.email||'').slice(0,200),notes:String(person.notes||'').slice(0,2000)}));
  } catch {return [];}
}

export async function gitIdentity(cwd) {
  const get=async key=>{try {return (await git(cwd,['config','--get',key])).trim();} catch {return '';}};
  return {name:await get('user.name'),email:await get('user.email')};
}

async function refExists(cwd,ref) {
  try {await git(cwd,['show-ref','--verify','--quiet',ref]);return true;} catch {return false;}
}

async function firstRemote(toplevel) {
  try {return (await git(toplevel,['remote'])).split('\n').map(line=>line.trim()).filter(Boolean)[0]||'';} catch {return '';}
}

// La copia oculta de la rama de encargos: se crea desde el remoto si ya existe, o como rama huérfana vacía.
export async function openLedger({projectPath,dataDir,projectId}) {
  const info=inspect(projectPath);
  if(info.kind!=='worktree')throw new Error('La cooperación por git necesita que la carpeta sea un repositorio git con al menos un commit.');
  const dir=path.join(dataDir,'coop',String(projectId).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,24)||'proyecto');
  const remote=await firstRemote(info.toplevel);
  let valid=false;
  try {valid=fs.existsSync(dir)&&(await git(dir,['rev-parse','--abbrev-ref','HEAD'])).trim()===LEDGER_BRANCH;} catch {valid=false;}
  if(!valid) {
    if(fs.existsSync(dir)) {
      try {await git(info.toplevel,['worktree','remove','--force',dir]);} catch {}
      try {fs.rmSync(dir,{recursive:true,force:true});} catch {}
    }
    try {await git(info.toplevel,['worktree','prune']);} catch {}
    fs.mkdirSync(path.dirname(dir),{recursive:true});
    if(remote) {try {await git(info.toplevel,['fetch','--quiet',remote,LEDGER_BRANCH],{timeout:30000});} catch {}}
    const hasLocal=await refExists(info.toplevel,`refs/heads/${LEDGER_BRANCH}`);
    const hasRemote=remote&&await refExists(info.toplevel,`refs/remotes/${remote}/${LEDGER_BRANCH}`);
    if(hasLocal)await git(info.toplevel,['worktree','add',dir,LEDGER_BRANCH]);
    else if(hasRemote)await git(info.toplevel,['worktree','add','--track','-b',LEDGER_BRANCH,dir,`${remote}/${LEDGER_BRANCH}`]);
    else {
      // Rama huérfana con solo el libro: nace de un árbol vacío, sin pasar el código del proyecto por la copia.
      const identity=await gitIdentity(info.toplevel);
      const author=identity.email?[]:IDENTITY;
      const emptyTree=execFileSync('git',['-C',info.toplevel,'mktree'],{input:'',encoding:'utf8',env:ENV,windowsHide:true}).trim();
      const root=execFileSync('git',['-C',info.toplevel,...author,'commit-tree',emptyTree,'-m','mixto: libro de encargos'],{encoding:'utf8',env:ENV,windowsHide:true}).trim();
      await git(info.toplevel,['branch',LEDGER_BRANCH,root]);
      await git(info.toplevel,['worktree','add',dir,LEDGER_BRANCH]);
      fs.writeFileSync(path.join(dir,'README.md'),README);
      fs.mkdirSync(path.join(dir,'encargos'),{recursive:true});
      fs.writeFileSync(path.join(dir,'encargos','.gitkeep'),'');
      await git(dir,['add','-A']);
      await run('git',['-C',dir,...author,'commit','--quiet','--no-verify','-m','mixto: libro de encargos, archivos'],{windowsHide:true,env:ENV});
    }
  }
  return {toplevel:info.toplevel,dir,remote};
}

// Lee el libro desde la copia de trabajo o desde una referencia (la rama remota ya traída).
export async function readLedger(dir,{ref}={}) {
  const assignments=new Map();
  let people=[];
  if(!ref) {
    try {people=parseRoster(fs.readFileSync(path.join(dir,'equipo.json'),'utf8'));} catch {}
    let files=[];
    try {files=fs.readdirSync(path.join(dir,'encargos')).filter(name=>name.endsWith('.md'));} catch {}
    for(const file of files) {
      const parsed=parseAssignment(fs.readFileSync(path.join(dir,'encargos',file),'utf8'));
      if(parsed)assignments.set(file,parsed);
    }
    return {assignments,people};
  }
  try {people=parseRoster(await git(dir,['show',`${ref}:equipo.json`]));} catch {}
  let listed='';
  try {listed=await git(dir,['ls-tree','--name-only',ref,'encargos/']);} catch {}
  for(const line of listed.split('\n')) {
    const file=path.posix.basename(line.trim());
    if(!file.endsWith('.md'))continue;
    try {const parsed=parseAssignment(await git(dir,['show',`${ref}:encargos/${file}`]));if(parsed)assignments.set(file,parsed);} catch {}
  }
  return {assignments,people};
}

// Commits que citan el encargo en cualquier rama ya traída: el más reciente lo da por hecho.
export async function commitsCiting(toplevel,assignmentId) {
  const short=shortId(assignmentId);
  if(short.length<8)return [];
  let out='';
  try {out=await git(toplevel,['log','--all','-i',`--grep=mixto:${short}`,'--format=%H%x1f%an%x1f%ae%x1f%cI%x1f%s']);} catch {return [];}
  return out.split('\n').filter(Boolean).map(line=>{const [hash,author,email,date,subject]=line.split('\x1f');return {hash,short:hash.slice(0,7),author,email,date,subject};});
}

export function writeLedger(dir,{assignments=[],people}) {
  let changed=0;
  const write=(file,content)=>{let current=null;try {current=fs.readFileSync(file,'utf8');} catch {}if(current!==content){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);changed++;}};
  for(const assignment of assignments)write(path.join(dir,'encargos',`${assignment.id}.md`),serializeAssignment(assignment));
  if(people)write(path.join(dir,'equipo.json'),serializeRoster(people));
  return changed;
}

// Trae la rama remota, mezcla su contenido con el local por fecha (notas unidas), deja la rama local
// sobre la punta remota para que el siguiente push sea directo, y da por hechos los encargos citados
// en commits. Devuelve el estado mezclado; el llamador decide qué hacer con él y si publica.
export async function syncLedger({projectPath,dataDir,projectId,fetch=false,localPeople=[]}) {
  const {toplevel,dir,remote}=await openLedger({projectPath,dataDir,projectId});
  const status={remote,fetched:false,fetchError:null,mergedFromRemote:false};
  const remoteRef=remote?`refs/remotes/${remote}/${LEDGER_BRANCH}`:null;
  if(fetch&&remote) {
    // Todas las ramas, no solo la del libro: los commits que citan un encargo viven en las ramas de código.
    try {
      await git(toplevel,['fetch','--quiet',remote],{timeout:45000});
      await git(toplevel,['fetch','--quiet',remote,`+refs/heads/${LEDGER_BRANCH}:refs/remotes/${remote}/${LEDGER_BRANCH}`],{timeout:30000}).catch(()=>{});
      status.fetched=true;
    } catch(error) {status.fetchError=reasonOf(error);}
  }
  const local=await readLedger(dir);
  const hasRemote=remoteRef?await refExists(toplevel,remoteRef):false;
  const incoming=hasRemote?await readLedger(dir,{ref:`${remote}/${LEDGER_BRANCH}`}):{assignments:new Map(),people:[]};
  const merged=new Map();
  for(const file of new Set([...local.assignments.keys(),...incoming.assignments.keys()])) {
    const result=mergeAssignments([local.assignments.get(file),incoming.assignments.get(file)]);
    if(result)merged.set(file,result);
  }
  // Personas: unión por id; el equipo local de Mixto tiene la última palabra sobre sus propios datos.
  const people=new Map();
  for(const person of incoming.people)people.set(person.id,person);
  for(const person of local.people)people.set(person.id,person);
  for(const person of localPeople)people.set(person.id,{id:person.id,name:person.name,role:person.role||'',email:person.email||'',notes:person.notes||''});
  const autoDone=[];
  // Un commit cierra el encargo una sola vez: si alguien lo reabre después, solo un commit nuevo lo vuelve a cerrar.
  for(const assignment of merged.values()) {
    assignment.commits||=[];
    const fresh=(await commitsCiting(toplevel,assignment.id)).filter(commit=>!assignment.commits.includes(commit.short));
    if(!fresh.length)continue;
    for(const commit of fresh)assignment.commits.push(commit.short);
    if(assignment.status==='hecha')continue;
    const commit=fresh[0];
    assignment.status='hecha';assignment.updatedAt=nowIso();
    assignment.notes.push(`${String(commit.date).slice(0,10)} · hecho en el commit ${commit.short} de ${commit.author}: ${commit.subject}`);
    autoDone.push(assignment.id);
  }
  if(hasRemote) {
    // Historia lineal: la rama local pasa a la punta remota conservando los archivos ya mezclados.
    const localHead=(await git(dir,['rev-parse','HEAD'])).trim();
    const remoteHead=(await git(dir,['rev-parse',`${remote}/${LEDGER_BRANCH}`])).trim();
    if(localHead!==remoteHead) {await git(dir,['reset','--quiet','--soft',`${remote}/${LEDGER_BRANCH}`]);status.mergedFromRemote=true;}
  }
  const assignments=[...merged.values()];
  const changed=writeLedger(dir,{assignments,people:[...people.values()]});
  return {toplevel,dir,remote,status,assignments,people:[...people.values()],autoDone,changed};
}

// Confirma lo que haya cambiado en el libro y lo publica en la rama de encargos del remoto.
export async function publishLedger({dir,remote,message='mixto: encargos'}) {
  const result={committed:false,pushed:false,error:null};
  await git(dir,['add','-A']);
  const staged=(await git(dir,['diff','--cached','--name-only'])).trim();
  if(staged) {
    const identity=await gitIdentity(dir);
    await run('git',['-C',dir,...(identity.email?[]:IDENTITY),'commit','--quiet','--no-verify','-m',message],{windowsHide:true,env:ENV});
    result.committed=true;
  }
  if(!remote) {result.error='El repositorio no tiene remoto: los encargos quedan confirmados solo en esta copia.';return result;}
  try {await git(dir,['push','--quiet','-u',remote,`${LEDGER_BRANCH}:${LEDGER_BRANCH}`],{timeout:30000});result.pushed=true;}
  catch(error) {result.error=reasonOf(error);}
  return result;
}

export async function removeLedger({projectPath,dataDir,projectId}) {
  const dir=path.join(dataDir,'coop',String(projectId).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,24)||'proyecto');
  if(!fs.existsSync(dir))return;
  let toplevel=null;
  try {toplevel=inspect(projectPath).toplevel;} catch {}
  if(toplevel) {try {await git(toplevel,['worktree','remove','--force',dir]);} catch {}}
  try {fs.rmSync(dir,{recursive:true,force:true});} catch {}
  if(toplevel) {try {await git(toplevel,['worktree','prune']);} catch {}}
}
