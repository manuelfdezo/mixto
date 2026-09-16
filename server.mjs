import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {Store,id,now,memoryContext,sessionKey,rememberSession} from './lib/store.mjs';
import {discover,runProvider,readLimits,closeAllSessions} from './lib/providers.mjs';
import {EngramBridge,sharedMemories,cleanupOrphanTransfers} from './lib/engram.mjs';
import {buildPlanPrompt,parsePlan,parseManualPlan,assignWaves,buildReviewPrompt,readVerdict,PlanError,buildSupervisionPrompt,parseDecision,buildWorkPrompt,buildFixPrompt,buildDirectPrompt,buildSelfPrompt,buildOpinionPrompt,buildCommitPrompt,steerPrefix,HUMAN,HUMAN_STATUSES,humanStatusLabel,findPerson} from './lib/orchestrator.mjs';
import {inspect,initRepository,createWorkspaces,createReviewWorkspace,capturePatch,checkPatches,applyPatches,removeWorkspaces,cleanupOrphanWorkspaces,snapshotProject,diffSince,parseDiff,revertPatch,projectChanges,commitFiles,pushBranch} from './lib/isolation.mjs';
import {commandAllowed,commandPrefix,cleanCommandList,claudeAllowedTools,looksLikeSessionLoss} from './lib/commands.mjs';
import {createManagedProject,managedProjectPath,projectsRoot,syncDiscoveredProjects} from './lib/projects.mjs';
import {listPersonas,personaBody} from './lib/personas.mjs';
import {Watcher} from './lib/supervisor.mjs';
import {openLedger,syncLedger,publishLedger,writeLedger,gitIdentity,STATUSES as LEDGER_STATUSES} from './lib/team.mjs';
import {updateSources,checkUpdate,downloadUpdate,applyUpdate,compareVersions} from './lib/update.mjs';
import {githubSources,applyAuth,clearAuth,parseRepoInput,fetchViewer,fetchRepos,cloneRepo,pullProject,hasRemote} from './lib/github.mjs';
import {chooseAgent,routingSummary,claudeUsage} from './lib/routing.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const VERSION=(()=>{try{return JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version||'0.0.0';}catch{return '0.0.0';}})();
const dataDir=path.resolve(process.env.MIXTO_DATA_DIR||path.join(root,'data'));
const managedProjectsRoot=projectsRoot(root);
// La carpeta de proyectos se crea sola la primera vez: nadie debería tener que crearla a mano.
try{fs.mkdirSync(managedProjectsRoot,{recursive:true});}catch(e){console.error('No se pudo crear la carpeta de proyectos '+managedProjectsRoot+': '+e.message);}
const port=Number(process.env.MIXTO_PORT||4317);
const origin=`http://127.0.0.1:${port}`;
const secret=randomBytes(32).toString('hex');
fs.mkdirSync(dataDir,{recursive:true});
const lockFile=path.join(dataDir,'server.lock');
try{
  if(fs.existsSync(lockFile)){
    const old=Number(fs.readFileSync(lockFile,'utf8'));
    const alive=()=>{try{process.kill(old,0);return true;}catch{return false;}};
    // Tras una actualización el servidor anterior aún se está retirando: se le dan hasta veinte segundos.
    if(process.env.MIXTO_RESTART==='1'){const deadline=Date.now()+20000;while(alive()&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);}
    if(alive())throw new Error(`Mixto ya está abierto. Abre ${origin}`);
    try{fs.unlinkSync(lockFile);}catch{} // el proceso anterior puede haberlo borrado justo al salir
  }
  fs.writeFileSync(lockFile,String(process.pid),{flag:'wx'});
}catch(e){console.error(e.message);process.exit(1);}
process.on('exit',()=>{try{if(fs.readFileSync(lockFile,'utf8')===String(process.pid))fs.unlinkSync(lockFile);}catch{}});
const store=new Store(dataDir,root);
const initialProjects=syncDiscoveredProjects(store.data,managedProjectsRoot);
if(initialProjects.added.length)store.save();
cleanupOrphanTransfers();
void cleanupOrphanWorkspaces({dataDir,projectPaths:store.data.projects.map(project=>project.path)}).catch(()=>{})
  .then(()=>{for(const run of store.data.runs){try{markFixable(run);}catch{}}store.save();});
const active=new Map(),approvals=new Map(),planGates=new Map();
const MAX_SUBTASKS=8;
const PROVIDERS=['codex','claude'];
const maxParallel=()=>Math.max(1,Math.min(6,Number(process.env.MIXTO_MAX_PARALLEL)||3));
// Comandos de solo lectura que el revisor puede ejecutar sin preguntar; todo lo demás pasa por el usuario.
const REVIEW_ALLOWED=['git diff','git status','git log','git show'].flatMap(command=>[`Bash(${command})`,`Bash(${command}:*)`,`Bash(${command} *)`]);
const memoryBridge=new EngramBridge(store);
const syncMemory=()=>active.size||!store.data.projects.length?Promise.resolve():memoryBridge.sync();
const memoryTimer=setInterval(()=>void syncMemory(),15000);
memoryTimer.unref();
const connections=Object.fromEntries(['codex','claude'].map(provider=>[provider,{connected:false,loading:true,models:store.data.catalogs?.[provider]||[]}]));
let refreshing=null,dirty=false;
// Los cambios se empujan a la interfaz por SSE en vez de sondearlos: `touch()` marca datos pendientes de
// guardar y de enviar, y `notify()` agrupa los envíos para no inundar mientras un agente escribe.
const clients=new Map();let pushTimer=null;
function broadcast(){
  if(!clients.size)return;
  const payloads=new Map();
  for(const [client,conversationId] of clients){
    let payload=payloads.get(conversationId);
    if(!payload){try{payload=`event: state\ndata: ${JSON.stringify(snapshot(conversationId))}\n\n`;}catch{return;}payloads.set(conversationId,payload);}
    try{client.write(payload);}catch{clients.delete(client);}
  }
}
function notify(){if(pushTimer||!clients.size)return;pushTimer=setTimeout(()=>{pushTimer=null;broadcast();},300);}
const touch=()=>{dirty=true;notify();};
const flush=()=>{store.save();dirty=false;notify();};
const keepalive=setInterval(()=>{for(const client of clients.keys()){try{client.write(': ping\n\n');}catch{clients.delete(client);}}},20000);
keepalive.unref();
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Terminal de proyecto (un comando a la vez por carpeta) y resumen de cambios sin confirmar por proyecto.
const execs=new Map(),changesCache=new Map();
const execView=record=>record?{id:record.id,command:record.command,status:record.status,code:record.code,startedAt:record.startedAt,finishedAt:record.finishedAt,output:record.output.slice(-65536)}:null;
const toSubtask=(item,index)=>({id:id(),index,human:false,personId:null,personName:null,...item,cwd:null,patch:null,diff:null,text:'',
  status:item.human?'pendiente':'queued',stage:item.human?`Asignada a ${item.personName}`:'En espera',result:'',due:null,assignmentId:null,updatedAt:null,
  events:[],messageId:null,sessionKey:null,sessionId:null,usage:null,error:null,startedAt:null,finishedAt:null,fixable:false,self:false});
const checkpoint=setInterval(()=>{if(dirty)try{flush();}catch(e){console.error('No se pudo guardar:',e.message);}},2000);
checkpoint.unref();

async function refreshConnections(){
  if(refreshing)return refreshing;
  refreshing=Promise.all(['codex','claude'].map(async provider=>{
    connections[provider]={...connections[provider],loading:true};notify();
    try{
      connections[provider]={...await discover(provider,root),loading:false};
      store.data.catalogs||={};store.data.catalogs[provider]=connections[provider].models;touch();
    }
    catch(e){connections[provider]={...connections[provider],connected:false,loading:false,error:e.message};}
  })).finally(()=>{refreshing=null;notify();});
  return refreshing;
}

// La cuota cambia con cada turno, también fuera de Mixto: se relee al terminar cada tarea, sin recargar el catálogo.
let limitsRefresh=null;
function refreshLimits(){
  if(limitsRefresh||!connections.codex.connected)return limitsRefresh||Promise.resolve();
  limitsRefresh=readLimits('codex',root).then(limits=>{if(limits){connections.codex={...connections.codex,limits};notify();}}).catch(()=>{}).finally(()=>{limitsRefresh=null;});
  return limitsRefresh;
}

// A missing value and an oversized one are different problems: saying "máximo N caracteres" for an
// empty field sends the user looking for a length limit that was never the cause.
function str(value,label,max=10000,empty=false){
  if(typeof value!=='string'||(!empty&&!value.trim()))throw new Error(`${label}: introduce un texto válido.`);
  if(value.length>max)throw new Error(`${label}: supera el máximo de ${max} caracteres.`);
  return value.trim();
}
function getRun(runId){const r=store.data.runs.find(r=>r.id===runId);if(!r)throw new Error('Tarea no encontrada.');return r;}
function sameFolder(a,b){return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;}
function folder(value){const p=str(value,'Carpeta',2000);if(!path.isAbsolute(p))throw new Error('Escribe la ruta completa de una carpeta.');const real=fs.realpathSync(p);if(!fs.statSync(real).isDirectory())throw new Error('La ruta debe ser una carpeta.');return real;}
// Un ENOENT puede ser una carpeta que no existe o un programa que no está instalado: se dice cuál.
function missingMessage(e){
  if(typeof e.syscall==='string'&&e.syscall.startsWith('spawn'))return `No se encontró el programa «${e.path||e.syscall.slice(6)}». Abre Mixto con Abrir-Mixto.cmd para que instale lo que falta.`;
  return `No se encontró la carpeta o el archivo${e.path?' «'+e.path+'»':''}. Comprueba la ruta.`;
}
function projectOf(run){return store.project(store.conversation(run.conversationId).projectId);}
const membersOf=project=>store.data.people.filter(person=>(project.members||[]).includes(person.id));
const assigneeName=subtask=>subtask.human?`${subtask.personName} (persona)`:`${agentName(subtask.provider)} ${subtask.model}`;
// Con personas en la tarea, la etapa de una tarea terminada dice cuántas partes siguen en sus manos.
function humansRollup(run){
  if(run.status!=='completed')return;
  const pending=run.subtasks.filter(subtask=>subtask.human&&subtask.status!=='hecha').length;
  run.stage=pending?`Pendiente de ${pending} persona${pending===1?'':'s'}`:'Completado';
}
function personFields(source,base={}){
  const email=str(source.email||'','Correo',200,true);
  if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Correo: escribe una dirección válida o déjalo vacío.');
  return {...base,name:str(source.name,'Nombre',80),role:str(source.role||'','Rol',80,true),email,notes:str(source.notes||'','Notas',2000,true)};
}

// Aprobación automática de los comandos permitidos en el proyecto; todo lo demás sigue pasando por el usuario.
// Los comandos de la lista del proyecto los aprueba el propio proveedor; el resto llega al usuario.
const allowCommandIn=project=>command=>commandAllowed(project.allowedCommands,command);
async function refreshChanges(project){
  try{const changes=await projectChanges(project.path,{withDiff:false});changesCache.set(project.id,{git:changes.git,files:changes.files.length,remote:changes.git&&await hasRemote(project.path),at:now()});}
  catch{changesCache.set(project.id,{git:false,files:0,remote:false,at:now()});}
  notify();
}
function startExec(project,command){
  const current=execs.get(project.id);
  if(current?.status==='running')throw new Error('Ya hay un comando en marcha en este proyecto. Detenlo o espera a que termine.');
  const record={id:id(),command,status:'running',code:null,output:'',startedAt:now(),finishedAt:null,child:null};
  const [shell,args]=process.platform==='win32'?[process.env.ComSpec||'cmd.exe',['/d','/s','/c',command]]:['/bin/sh',['-c',command]];
  const child=spawn(shell,args,{cwd:project.path,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
  record.child=child;
  const append=chunk=>{record.output=(record.output+chunk.toString()).slice(-1024*1024);notify();};
  child.stdout.on('data',append);child.stderr.on('data',append);
  const timer=setTimeout(()=>{if(record.status==='running'){record.output+='\n[Mixto] Detenido tras 10 minutos.';stopExec(project);}},600000);
  timer.unref();
  child.on('exit',(code,signal)=>{clearTimeout(timer);record.status=signal||record.stopping?'stopped':'finished';record.code=code;record.finishedAt=now();void refreshChanges(project);notify();});
  child.on('error',error=>{clearTimeout(timer);record.status='error';record.output+='\n'+error.message;record.finishedAt=now();notify();});
  execs.set(project.id,record);notify();
  return record;
}
function stopExec(project){
  const record=execs.get(project.id);
  if(!record||record.status!=='running')return;
  record.stopping=true;
  if(process.platform==='win32'&&record.child?.pid)execFile('taskkill.exe',['/PID',String(record.child.pid),'/T','/F'],{windowsHide:true},()=>{});
  else record.child?.kill();
}
// Mensaje de commit propuesto por un agente en un solo turno, sin sesión ni memoria: solo el diff.
async function proposeCommit(project,body){
  const changes=await projectChanges(project.path);
  if(!changes.git)throw new Error('La carpeta no es un repositorio git.');
  if(!changes.files.length)throw new Error('No hay cambios sin confirmar.');
  const provider=PROVIDERS.includes(body.provider)?body.provider:'codex';
  if(!connections[provider].connected)throw new Error(`${agentName(provider)} no está conectado.`);
  const chosen=modelChoice(provider,body.model,body.effort);
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),180000);
  try{
    const result=await runProvider(provider,{cwd:project.path,model:chosen.model,effort:chosen.effort,prompt:buildCommitPrompt(changes),readOnly:true,
      signal:controller.signal,onSession:()=>{},onText:()=>{},onEvent:()=>{},approve:()=>Promise.resolve({allow:false})});
    const message=String(result.text||'').replace(/^```[\w-]*\n?/,'').replace(/\n?```\s*$/,'').trim();
    if(!message)throw new Error('El agente no propuso ningún mensaje.');
    return {message,files:changes.files,usage:result.usage};
  }finally{clearTimeout(timer);}
}
// Redirigir: detener el turno en directo y reanudar la misma sesión con la nueva indicación.
async function steerRun(body){
  const run=getRun(body.runId);
  if(run.mode!=='directo')throw new Error('Solo se puede redirigir un turno del modo directo.');
  const controller=active.get(run.id);
  if(!controller)throw new Error('Ese turno ya ha terminado; envía un mensaje nuevo.');
  const text=str(body.prompt,'Indicación',20000);
  controller.abort({steer:true});
  for(let attempt=0;attempt<100&&active.has(run.id);attempt++)await wait(100);
  if(active.has(run.id))throw new Error('El turno no se detuvo a tiempo; inténtalo de nuevo.');
  return startRun({conversationId:run.conversationId,prompt:steerPrefix(text),display:text,mode:'directo',readOnly:run.readOnly,
    attachments:body.attachments,orchestrator:{provider:run.orchestrator.provider,model:run.orchestrator.model,effort:run.orchestrator.effort}});
}
function diffOf(runId,subtaskId){
  const run=getRun(runId),project=projectOf(run);
  const subtask=run.subtasks.find(candidate=>candidate.id===subtaskId);
  if(!subtask)throw new Error('Sub-tarea no encontrada.');
  const change=subtask.patch||subtask.diff;
  if(!change?.file)throw new Error('Esta parte no dejó cambios en archivos.');
  let text='';
  try{text=fs.readFileSync(change.file,'utf8');}catch{throw new Error('El diff ya no está disponible.');}
  const files=parseDiff(text);
  let toplevel=run.snapshot?.toplevel;
  if(!toplevel){try{toplevel=inspect(project.path).toplevel||project.path;}catch{toplevel=project.path;}}
  const created=[];
  for(const relative of change.created||[]){
    const full=path.join(toplevel,relative);
    let content=null,exists=false,binary=false;
    try{const stat=fs.statSync(full);exists=true;if(stat.size<=200*1024){const raw=fs.readFileSync(full);if(raw.includes(0))binary=true;else content=raw.toString('utf8');}}catch{}
    created.push({path:relative,status:'added',exists,binary,text:content===null?'':content.replace(/\n$/,'').split('\n').map(line=>'+'+line).join('\n')});
  }
  const applied=run.review?.integration?.applied||[];
  const pending=!!subtask.patch&&!applied.includes(subtask.patch.file)&&!run.review?.integration?.discarded;
  return {source:subtask.patch?'patch':'diff',pending,applied:subtask.patch?applied.includes(subtask.patch.file):!subtask.reverted,
    reverted:!!subtask.reverted,revertedFiles:subtask.revertedFiles||[],excluded:subtask.patchExcludes||[],files,created,
    summary:{files:files.length+created.length,additions:files.reduce((n,file)=>n+file.additions,0)+created.reduce((n,file)=>n+(file.text?file.text.split('\n').length:0),0),deletions:files.reduce((n,file)=>n+file.deletions,0)}};
}
const patchExcludesOf=run=>Object.fromEntries(run.subtasks.filter(subtask=>subtask.patch).map(subtask=>[subtask.patch.file,subtask.patchExcludes||[]]));

// Cooperación por git: el libro de encargos del proyecto vive en la rama `mixto-encargos` del repositorio.
// Todas las operaciones sobre el libro de un proyecto van en fila, para no pisarse entre sí.
const coopChains=new Map();
function coopSerial(project,fn){
  const previous=coopChains.get(project.id)||Promise.resolve();
  const next=previous.then(fn,fn);
  coopChains.set(project.id,next.catch(()=>{}));
  return next;
}
function coopOf(project){
  project.cooperation||={enabled:false,autoPublish:true,lastSync:null,lastPublish:null,pendingPublish:false,error:null,identity:null,remote:null};
  project.assignments||=[];
  return project.cooperation;
}
const coopEnabled=project=>!!project.cooperation?.enabled;
const humanStage=(status,name)=>status==='hecha'?`Hecha por ${name}`:status==='en-curso'?`En curso · ${name}`:`Asignada a ${name}`;
function pendingFor(project,personId){
  let count=project.assignments?.filter(a=>a.personId===personId&&a.status!=='hecha').length||0;
  const known=new Set((project.assignments||[]).map(a=>a.origin));
  for(const run of store.data.runs){
    if(store.conversation(run.conversationId)?.projectId!==project.id)continue;
    for(const subtask of run.subtasks||[])if(subtask.human&&subtask.personId===personId&&subtask.status!=='hecha'&&!known.has(`${run.id}/${subtask.id}`))count++;
  }
  return count;
}
function assignmentFromSubtask(run,subtask,project){
  const person=store.data.people.find(candidate=>candidate.id===subtask.personId);
  const identity=coopOf(project).identity;
  return {id:subtask.id,project:project.name,title:subtask.title,personId:subtask.personId,personName:person?.name||subtask.personName,personEmail:person?.email||'',
    status:subtask.status,due:subtask.due||null,createdBy:identity?.email?`${identity.name} <${identity.email}>`:'Mixto',createdAt:run.createdAt,updatedAt:subtask.updatedAt||run.createdAt,
    task:run.prompt.slice(0,300),origin:`${run.id}/${subtask.id}`,instructions:`Rol: ${subtask.role}\n\n${subtask.instructions}`,scope:subtask.scope||[],
    context:run.plan?.context||'',notes:subtask.result?[subtask.result]:[]};
}
function cacheAssignment(project,entry){
  const list=coopOf(project)&&project.assignments;
  const index=list.findIndex(candidate=>candidate.id===entry.id);
  if(index>=0)list[index]=entry;else list.push(entry);
}
// Lo que llega del libro pasa a las personas, a la caché del proyecto y a las partes humanas de las tareas locales.
function applyLedgerToState(project,synced){
  const coop=coopOf(project);
  for(const person of synced.people){
    let local=store.data.people.find(candidate=>candidate.id===person.id);
    if(!local){local={...person,createdAt:now(),imported:true};store.data.people.push(local);}
    project.members||=[];
    if(!project.members.includes(local.id))project.members.push(local.id);
  }
  project.assignments=synced.assignments.map(entry=>({...entry}));
  const touched=new Set();
  for(const entry of synced.assignments){
    const [runId,subtaskId]=String(entry.origin||'').split('/');
    if(!runId)continue;
    const run=store.data.runs.find(candidate=>candidate.id===runId),subtask=run?.subtasks.find(candidate=>candidate.id===subtaskId);
    if(!run||!subtask?.human)continue;
    subtask.assignmentId=entry.id;
    if((subtask.updatedAt||'')>=entry.updatedAt)continue;
    subtask.status=entry.status;subtask.due=entry.due;subtask.updatedAt=entry.updatedAt;
    if(entry.notes.length)subtask.result=entry.notes[entry.notes.length-1];
    subtask.stage=humanStage(entry.status,subtask.personName);
    subtask.finishedAt=entry.status==='hecha'?(subtask.finishedAt||now()):null;
    touched.add(run);
  }
  for(const run of touched){humansRollup(run);if(run.phase==='done')recordRunMemory(run);}
  coop.lastSync=now();coop.remote=synced.remote||null;coop.error=synced.status.fetchError||null;
  touch();
}
async function coopPublishNow(project,opened){
  const coop=coopOf(project);
  const {dir,remote}=opened||await openLedger({projectPath:project.path,dataDir,projectId:project.id});
  let result=await publishLedger({dir,remote});
  // Un push rechazado significa que otro Mixto publicó antes: se mezcla lo suyo y se vuelve a intentar una vez.
  if(!result.pushed&&result.error&&/rejected|fetch first|non-fast-forward|behind/i.test(result.error)){
    const synced=await syncLedger({projectPath:project.path,dataDir,projectId:project.id,fetch:true,localPeople:membersOf(project)});
    applyLedgerToState(project,synced);
    result=await publishLedger({dir,remote});
  }
  coop.lastPublish={at:now(),committed:result.committed,pushed:result.pushed,error:result.error};
  coop.pendingPublish=!!result.error&&!result.pushed;
  coop.error=result.error;
  touch();
  return result;
}
function coopSync(project,{fetch=false,publish=false}={}){
  return coopSerial(project,async()=>{
    const coop=coopOf(project);
    try{
      const identity=await gitIdentity(project.path);
      const synced=await syncLedger({projectPath:project.path,dataDir,projectId:project.id,fetch,localPeople:membersOf(project)});
      applyLedgerToState(project,synced);
      const me=synced.people.find(person=>person.email&&identity.email&&person.email.toLowerCase()===identity.email.toLowerCase());
      coop.identity={name:identity.name,email:identity.email,personId:me?.id||null};
      if(synced.autoDone.length)pushEventProject(project,`Encargos dados por hechos por sus commits: ${synced.autoDone.length}.`);
      const dirty=synced.changed>0||synced.autoDone.length>0||coop.pendingPublish;
      if((publish||dirty)&&coop.autoPublish)await coopPublishNow(project,synced);
      else if(dirty)coop.pendingPublish=true;
      touch();
      return synced;
    }catch(error){coop.error=error.message;touch();throw error;}
  });
}
function pushEventProject(project,text){coopOf(project).lastEvent={at:now(),text};}
// Escribe encargos (y el equipo) en el libro y, si procede, publica.
function coopUpsert(project,entries){
  return coopSerial(project,async()=>{
    const coop=coopOf(project);
    try{
      const opened=await openLedger({projectPath:project.path,dataDir,projectId:project.id});
      writeLedger(opened.dir,{assignments:entries,people:membersOf(project)});
      for(const entry of entries)cacheAssignment(project,entry);
      touch();
      if(coop.autoPublish)await coopPublishNow(project,opened);else{coop.pendingPublish=true;touch();}
    }catch(error){coop.error=error.message;touch();throw error;}
  });
}
// Al asignar partes a personas en una tarea de un proyecto cooperativo, cada una pasa al libro.
function coopBackfillRun(run,project){
  const entries=[];
  for(const subtask of run.subtasks){
    if(!subtask.human||subtask.assignmentId)continue;
    subtask.assignmentId=subtask.id;subtask.updatedAt=subtask.updatedAt||now();
    entries.push(assignmentFromSubtask(run,subtask,project));
  }
  if(!entries.length)return Promise.resolve();
  return coopUpsert(project,entries);
}
async function coopEnableNow(project){
  await coopSync(project,{fetch:true});
  for(const run of store.data.runs){
    if(store.conversation(run.conversationId)?.projectId!==project.id)continue;
    await coopBackfillRun(run,project).catch(()=>{});
  }
  await coopSync(project,{fetch:false,publish:true});
}
// Cambio de estado, fecha o nota de una parte humana: vale para la tarjeta de la tarea, el tablero y el libro.
async function updateHumanPart(project,{run,subtask,assignment},{status,due,note}){
  const stamp=now();
  if(status!==undefined&&!LEDGER_STATUSES.includes(status))throw new Error('Estado no válido: pendiente, en-curso o hecha.');
  if(due!==undefined&&due&&!/^\d{4}-\d{2}-\d{2}$/.test(due))throw new Error('Fecha límite: usa el formato AAAA-MM-DD.');
  const who=coopOf(project).identity?.name||'';
  const line=note?`${stamp.slice(0,10)}${who?` · ${who}`:''}: ${note}`:null;
  if(subtask){
    if(status!==undefined){
      subtask.status=status;subtask.stage=humanStage(status,subtask.personName);
      subtask.finishedAt=status==='hecha'?stamp:null;
      if(status!=='pendiente'&&!subtask.startedAt)subtask.startedAt=stamp;
    }
    if(due!==undefined)subtask.due=due||null;
    if(note)subtask.result=note;
    subtask.updatedAt=stamp;
    if(run){humansRollup(run);if(run.phase==='done')recordRunMemory(run);}
  }
  let entry=assignment||(subtask?.assignmentId?project.assignments?.find(candidate=>candidate.id===subtask.assignmentId):null);
  if(!entry&&subtask&&run&&coopEnabled(project)){entry=assignmentFromSubtask(run,subtask,project);subtask.assignmentId=entry.id;}
  if(entry){
    if(status!==undefined)entry.status=status;
    if(due!==undefined)entry.due=due||null;
    if(line)entry.notes=[...(entry.notes||[]),line];
    entry.updatedAt=stamp;
    if(!subtask){
      // Un encargo con origen en una tarea local de este mismo Mixto también actualiza esa parte.
      const [runId,subtaskId]=String(entry.origin||'').split('/');
      const localRun=store.data.runs.find(candidate=>candidate.id===runId),localSubtask=localRun?.subtasks.find(candidate=>candidate.id===subtaskId);
      if(localSubtask?.human){
        localSubtask.status=entry.status;localSubtask.due=entry.due;localSubtask.updatedAt=stamp;localSubtask.stage=humanStage(entry.status,localSubtask.personName);
        localSubtask.finishedAt=entry.status==='hecha'?stamp:null;if(line)localSubtask.result=note;
        humansRollup(localRun);if(localRun.phase==='done')recordRunMemory(localRun);
      }
    }
    if(coopEnabled(project))await coopUpsert(project,[entry]);else cacheAssignment(project,entry);
  }
  touch();
}
// La carpeta de proyectos se relee como mucho cada dos segundos, no en cada actualización.
let discoveredCache={at:0,result:null};
function discovered(){
  if(!discoveredCache.result||Date.now()-discoveredCache.at>2000){
    discoveredCache={at:Date.now(),result:syncDiscoveredProjects(store.data,managedProjectsRoot)};
    if(discoveredCache.result.added.length)flush();
  }
  return discoveredCache.result;
}
// Una tarea de otra conversación viaja resumida: sin eventos ni textos largos, que solo se ven en la suya.
const briefRun=run=>({id:run.id,conversationId:run.conversationId,status:run.status,stage:run.stage,mode:run.mode,prompt:String(run.prompt||'').slice(0,200),createdAt:run.createdAt,finishedAt:run.finishedAt,usage:run.usage,phase:run.phase,events:[],plan:null,review:null,
  subtasks:(run.subtasks||[]).map(subtask=>({id:subtask.id,index:subtask.index,title:subtask.title,status:subtask.status,stage:subtask.stage,provider:subtask.provider,model:subtask.model,human:subtask.human,personId:subtask.personId,personName:subtask.personName,result:subtask.result,due:subtask.due,role:subtask.role,instructions:subtask.human?subtask.instructions:'',scope:subtask.scope,justification:subtask.human?subtask.justification:'',events:[],text:''}))});
// Sin conversación (`null`) el estado lleva todos los mensajes y tareas completas; con una, solo los suyos.
function snapshot(conversationId=null,{all=conversationId===null}={}){
  const managed=discovered();
  const {engram,github,...data}=store.data;
  const messages=all?data.messages:data.messages.filter(m=>m.conversationId===conversationId);
  const runs=all?data.runs:data.runs.map(run=>run.conversationId===conversationId?run:briefRun(run));
  return {...data,messages,runs,focus:all?undefined:conversationId,memories:sharedMemories(store.data),memorySync:memoryBridge.status,connections,personas:listPersonas(),
    approvals:[...approvals.values()].map(a=>a.public),execs:Object.fromEntries([...execs].map(([projectId,record])=>[projectId,execView(record)])),
    changes:Object.fromEntries(changesCache),update,github:githubView(),quota:{claude:claudeUsage(store.data.messages)},app:{version:VERSION,workspace:root,
      projectsRoot:{path:managed.root,available:managed.available}}};
}
// GitHub: con un token guardado, git (el de Mixto, el de los agentes y el del terminal) lleva la autorización por entorno.
const githubFrom=githubSources();
if(store.data.github?.token)applyAuth(store.data.github.token);
const githubView=()=>{const g=store.data.github;return g?.token?{connected:true,login:g.login,name:g.name||'',avatarUrl:g.avatarUrl||'',connectedAt:g.connectedAt,web:githubFrom.web}:{connected:false,web:githubFrom.web};};
let repoCache={at:0,repos:[]};
async function githubRepos(force=false){
  const token=store.data.github?.token;if(!token)throw new Error('Conecta GitHub en Agentes y ajustes.');
  if(force||Date.now()-repoCache.at>2*60*1000)repoCache={at:Date.now(),repos:await fetchRepos(githubFrom,token)};
  return repoCache.repos.map(repo=>({...repo,project:store.data.projects.find(p=>p.github?.fullName===repo.fullName)?.id||null}));
}
async function cloneFromGithub(body){
  const fullName=parseRepoInput(body.fullName||body.url);
  if(!fullName)throw new Error('Indica el repositorio como owner/nombre o con su URL de GitHub.');
  const directoryName=str(body.directoryName||fullName.split('/')[1],'Nombre de carpeta',80).replace(/[^A-Za-z0-9._-]+/g,'-').replace(/^[^A-Za-z0-9]+/,'');
  const target=managedProjectPath(managedProjectsRoot,directoryName,{mustExist:false});
  if(fs.existsSync(target))throw new Error(`Ya existe la carpeta ${directoryName} en tu carpeta de proyectos.`);
  const result=await cloneRepo({sources:githubFrom,fullName,into:target});
  if(!result.ok){try{fs.rmSync(target,{recursive:true,force:true});}catch{}throw new Error('No se pudo clonar: '+result.error);}
  const project=createManagedProject(store.data,managedProjectsRoot,{name:str(body.name||fullName.split('/')[1],'Nombre',80),directoryName,description:str(body.description||'','Descripción',2000,true)});
  project.github={fullName,htmlUrl:`${githubFrom.web}/${fullName}`};
  flush();void refreshChanges(project);
  return project;
}
// Actualización desde la app: la versión publicada en GitHub, comprobada al arrancar y cada seis horas.
const updateFrom=updateSources();
let update={current:VERSION,latest:null,available:false,checkedAt:null,error:null,applying:false,applied:null,downloadUrl:updateFrom.zipUrl,pageUrl:updateFrom.pageUrl};
async function checkUpdates(){
  if(!updateFrom.enabled)return update;
  try{update={...update,...await checkUpdate({current:VERSION,sources:updateFrom}),checkedAt:now(),error:null};}
  catch(error){update={...update,checkedAt:now(),error:error.message};}
  touch();return update;
}
async function applyUpdateNow(){
  if(active.size)throw new Error('Espera a que terminen las tareas activas antes de actualizar.');
  if(update.applying)throw new Error('Ya hay una actualización en marcha.');
  update={...update,applying:true};touch();
  let downloaded=null;
  try{
    if(!update.available){await checkUpdates();if(!update.available)throw new Error(update.error||'No hay ninguna versión nueva.');}
    const runtime=path.join(root,'.runtime');fs.mkdirSync(runtime,{recursive:true});
    downloaded=await downloadUpdate({sources:updateFrom,into:path.join(runtime,'updates')});
    const version=JSON.parse(fs.readFileSync(path.join(downloaded.sourceDir,'package.json'),'utf8')).version;
    if(compareVersions(version,VERSION)<=0)throw new Error(`La descarga es la versión ${version}, no más nueva que la ${VERSION}.`);
    const result=applyUpdate({root,sourceDir:downloaded.sourceDir,manifestFile:path.join(runtime,'instalado.json'),backupDir:path.join(runtime,'backup',VERSION)});
    update={...update,applying:false,applied:result.version};touch();
    setTimeout(restart,400);
    return {ok:true,...result};
  }catch(error){update={...update,applying:false};touch();throw error;}
  finally{if(downloaded)try{fs.rmSync(downloaded.dir,{recursive:true,force:true});}catch{}}
}
function message(conversationId,role,content,extra={}){const m={id:id(),conversationId,role,content,createdAt:now(),...extra};store.data.messages.push(m);return m;}

const agentName=provider=>provider==='claude'?'Claude Code':'Codex';
const pushEvent=(run,text)=>{run.events.push({time:now(),text:String(text).slice(0,1500)});run.events=run.events.slice(-60);touch();};

// Todo turno de la tarea suma aquí, también los del arquitecto: es lo que cuesta la tarea entera. El tope
// se comprueba al cerrar cada turno, así que puede excederse por uno; al superarlo la tarea se detiene.
function addUsage(run,usage){
  if(!usage)return;
  run.usage||={input:0,cached:0,output:0,total:0,costUsd:0,turns:0};
  for(const key of ['input','cached','output','total','costUsd'])run.usage[key]+=Number(usage[key])||0;
  run.usage.turns++;touch();
  const budget=Math.floor(Number(store.data.settings.tokenBudget))||0;
  if(budget>0&&run.usage.total>budget&&!run.budgetExceeded){
    run.budgetExceeded=true;
    pushEvent(run,`La tarea superó el tope de ${budget} tokens (lleva ${run.usage.total}); se detiene.`);
    active.get(run.id)?.abort({budget:true,limit:budget,total:run.usage.total});
  }
}

// The run's own status is never written by a sub-task: with several running at once it is derived here.
function rollup(run){
  if(run.phase!=='work')return;
  run.status=(run.subtasks||[]).some(subtask=>subtask.status==='waiting')?'waiting':'running';
}

function noteAuthFailure(provider,text){
  if(!/authenticat|oauth|session expired|not logged in|unauthorized|401/i.test(text))return null;
  connections[provider]={...connections[provider],connected:false,error:'La sesión ha caducado o no se ha podido autenticar. Inicia sesión en la herramienta oficial y actualiza la conexión.'};
  return `${agentName(provider)} necesita renovar su sesión. Abre Conexiones y agentes para volver a conectar.`;
}

function ask(run,subtask,request,signal,label){
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(new Error('Tarea detenida.'));return;}
    const requestId=id();
    const abort=()=>{approvals.delete(requestId);reject(new Error('Tarea detenida.'));};
    signal.addEventListener('abort',abort,{once:true});
    approvals.set(requestId,{public:{id:requestId,runId:run.id,conversationId:run.conversationId,subtaskId:subtask.id,provider:subtask.provider,
      label:label||`#${subtask.index+1} ${subtask.title} · ${subtask.model}`,...request},
      resolve:answer=>{signal.removeEventListener('abort',abort);approvals.delete(requestId);subtask.status='running';if(run.phase==='review')run.status='reviewing';rollup(run);touch();resolve(answer);}});
    subtask.status='waiting';if(run.phase==='review')run.status='waiting';rollup(run);flush();
  });
}

function awaitPlanDecision(run,signal){
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(new Error('Tarea detenida.'));return;}
    const abort=()=>{planGates.delete(run.id);reject(new Error('Tarea detenida.'));};
    signal.addEventListener('abort',abort,{once:true});
    planGates.set(run.id,decision=>{signal.removeEventListener('abort',abort);planGates.delete(run.id);resolve(decision);});
    run.status='awaiting-plan';run.stage='Esperando tu aprobación';flush();
  });
}

function modelChoice(provider,model,effort){
  if(typeof model!=='string'||!model.trim())throw new Error(`Elige el modelo de ${agentName(provider)} antes de enviar la tarea.`);
  const checked=str(model,'Modelo',200);
  if(!/^[a-zA-Z0-9._:[\]\/-]+$/.test(checked)||checked.startsWith('-'))throw new Error('Identificador de modelo no válido.');
  const catalog=connections[provider].models.find(candidate=>candidate.id===checked);
  if(effort&&!(catalog?.efforts||['low','medium','high','xhigh','max','ultra']).includes(effort))throw new Error('Ese nivel de razonamiento no está disponible para el modelo.');
  return {model:checked,effort:effort||null};
}

// The user may reassign a sub-task to the other agent, trade a model down or tighten it to read-only;
// everything else in the plan stays as the orchestrator wrote it. One bad choice never blocks the rest.
function applyPlanChoices(run,choices){
  const people=membersOf(projectOf(run));
  for(const choice of Array.isArray(choices)?choices:[]){
    const subtask=run.subtasks.find(candidate=>candidate.id===choice?.id);
    if(!subtask)continue;
    try{
      if(choice.provider===HUMAN){
        const person=findPerson(people,choice.personId||choice.person);
        if(!person)throw new Error('Esa persona no está en el equipo del proyecto.');
        if(subtask.human&&subtask.personId===person.id)continue;
        Object.assign(subtask,{provider:HUMAN,personId:person.id,personName:person.name,human:true,model:null,effort:null,readOnly:false,
          status:'pendiente',stage:`Asignada a ${person.name}`,cwd:null,self:false});
        pushEvent(run,`Sub-tarea #${subtask.index+1} asignada a ${person.name} (persona).`);
        continue;
      }
      const wasHuman=subtask.human===true;
      const provider=PROVIDERS.includes(choice.provider)?choice.provider:(wasHuman?run.orchestrator.provider:subtask.provider);
      const moved=wasHuman||provider!==subtask.provider;
      if(moved&&!connections[provider].connected)throw new Error(`${agentName(provider)} no está conectado.`);
      const fallbackModel=moved?(connections[provider].models.find(m=>m.default)||connections[provider].models[0])?.id:subtask.model;
      const chosen=modelChoice(provider,choice.model||fallbackModel,choice.effort===undefined?(moved?null:subtask.effort):choice.effort);
      if(moved)pushEvent(run,`Sub-tarea #${subtask.index+1} reasignada a ${agentName(provider)} (${chosen.model}).`);
      Object.assign(subtask,{provider,model:chosen.model,effort:chosen.effort,human:false,personId:null,personName:null});
      if(wasHuman){subtask.status='queued';subtask.stage='En espera';subtask.readOnly=run.readOnly===true;}
      if(choice.readOnly===true&&!subtask.readOnly){subtask.readOnly=true;pushEvent(run,`Sub-tarea #${subtask.index+1} limitada a solo lectura.`);}
    }catch(error){pushEvent(run,`No se pudo aplicar tu elección en la sub-tarea #${subtask.index+1}: ${error.message}`);}
  }
}

async function orchestratorRun(run,{prompt,sessionId,controller,onText,cwd,extraTools,allowedTools,approve,attachments,allowCommand}){
  const project=projectOf(run);
  const options=sid=>({
    cwd:cwd||project.path,model:run.orchestrator.model,effort:run.orchestrator.effort,prompt,readOnly:true,extraTools,allowedTools,attachments,allowCommand,
    // The architect's session is kept alive across plan, supervision and review turns: it never re-explains itself.
    sessionId:sid,signal:controller.signal,
    onSession:next=>{run.orchestrator.sessionId=next;touch();},onText,
    onEvent:text=>pushEvent(run,text),
    approve:approve||(()=>Promise.resolve({allow:false}))
  });
  const resume=sessionId??run.orchestrator.sessionId??undefined;
  let result;
  try{result=await runProvider(run.orchestrator.provider,options(resume));}
  catch(error){
    // Una sesión nativa que ya no existe no debe tumbar la tarea: se empieza otra y se sigue.
    if(!resume||controller.signal.aborted||!looksLikeSessionLoss(error))throw error;
    pushEvent(run,'La sesión nativa del arquitecto no se pudo reanudar; empieza una nueva.');
    run.orchestrator.sessionId=null;
    result=await runProvider(run.orchestrator.provider,options(undefined));
  }
  addUsage(run,result.usage);
  return result;
}

async function planPhase(run,controller){
  const conv=store.conversation(run.conversationId),project=store.project(conv.projectId);
  run.phase='plan';run.status='planning';run.stage='Planificando';
  const memory=memoryContext({...store.data,memories:sharedMemories(store.data)},project.id,conv.id,run.prompt);
  const prior=store.data.messages.filter(m=>m.conversationId===conv.id&&m.runId!==run.id&&m.status!=='error').slice(-12);
  const history=prior.map(m=>`${m.provider||m.role}: ${m.content}`).join('\n\n').slice(-24000);
  const current=message(conv.id,'assistant','',{provider:run.orchestrator.provider,model:run.orchestrator.model,
    status:'streaming',runId:run.id,subtaskId:null,kind:'plan',stage:'Plan'});
  flush();
  // La persona da el enfoque; las preferencias del usuario van después para que, si chocan, ganen las suyas.
  const instructions=[personaBody(store.data.settings.orchestratorPersona),
    store.data.settings[run.orchestrator.provider+'Instructions']||''].filter(Boolean).join('\n\n');
  const people=membersOf(project).map(person=>({...person,pending:pendingFor(project,person.id)}));
  // Con la sesión del arquitecto reanudada, el historial ya está en su contexto: no se repite.
  const resumed=!!run.orchestrator.sessionId;
  if(resumed)pushEvent(run,'El arquitecto reanuda su sesión de esta conversación.');
  let prompt=buildPlanPrompt({request:run.prompt,connections,memory,history:resumed?'':history,
    instructions,maxSubtasks:MAX_SUBTASKS,maxParallel:maxParallel(),readOnly:run.readOnly,people,balance:store.data.settings.balance||'auto',
    routing:routingSummary({connections,messages:store.data.messages,settings:store.data.settings})});
  let parsed=null,sessionId,lastError;
  for(let attempt=0;attempt<2&&!parsed;attempt++){
    const result=await orchestratorRun(run,{prompt,sessionId,controller,attachments:attempt===0?run.attachments:undefined,onText:text=>{current.content=text;touch();}});
    sessionId=result.sessionId||sessionId;
    current.content=result.text||current.content;current.usage=result.usage;
    try {parsed=parsePlan(result.text,{connections,maxSubtasks:MAX_SUBTASKS,runReadOnly:run.readOnly,people});}
    catch(error) {
      if(!(error instanceof PlanError))throw error;
      lastError=error.message;
      pushEvent(run,'El plan no se pudo interpretar: '+error.message);
      prompt=`Tu respuesta anterior no se pudo interpretar como plan: ${error.message}\n\nDevuelve únicamente el bloque \`\`\`json, sin nada alrededor.`;
    }
  }
  if(run.orchestrator.sessionId)rememberSession(conv,'architect:'+run.orchestrator.provider,run.orchestrator.sessionId);
  // Una respuesta directa cierra la tarea aquí: el arquitecto ya exploró lo necesario y no hay nada que repartir.
  if(parsed?.direct){
    current.content=parsed.answer;current.status='completed';current.kind='answer';current.stage='Respuesta';
    run.plan={status:'direct',summary:'',warnings:[],context:''};run.answer=parsed.answer;
    flush();return {direct:true};
  }
  // An unreadable plan never becomes an error the user has to decode: fall back to a single agent.
  const fallback=!parsed;
  if(fallback)parsed={summary:'No se pudo interpretar un plan; la petición se ejecuta con un solo agente.',
    warnings:[lastError].filter(Boolean),context:'',
    subtasks:[{title:'Tarea completa',role:'Resolver la petición del usuario',instructions:run.prompt,justification:'',
      provider:run.orchestrator.provider,model:run.orchestrator.model,effort:run.orchestrator.effort,scope:[],
      readOnly:run.readOnly===true,order:1}]};
  run.plan={status:fallback?'fallback':'ready',summary:parsed.summary,warnings:parsed.warnings,context:parsed.context||''};
  run.subtasks=parsed.subtasks.map(toSubtask);
  current.status='completed';current.stage='Plan';
  if(!current.content.trim())current.content=parsed.summary;
  // Inspected before the gate so the approval screen can ask about a folder without git.
  const info=inspect(project.path);
  run.isolation={kind:info.kind,relative:info.relative,reason:info.reason,warnings:[],roots:{},base:null};
  flush();
  // Los planes triviales pueden arrancar solos si el usuario lo ha pedido; un plan de emergencia, nunca.
  const settings=store.data.settings,single=run.subtasks.length===1,allRead=run.subtasks.every(subtask=>subtask.readOnly);
  if(!fallback&&((single&&settings.autoApproveSingle)||(allRead&&settings.autoApproveReadOnly))){
    run.plan.autoApproved=true;
    pushEvent(run,single?'Plan de una sola sub-tarea aprobado automáticamente, según tus ajustes.':'Plan de solo lectura aprobado automáticamente, según tus ajustes.');
    return {approve:true,initRepo:false,subtasks:[]};
  }
  const decision=await awaitPlanDecision(run,controller.signal);
  if(!decision.approve){run.plan.status='rejected';return null;}
  // Una elección de modelo que ya no encaja en el catálogo no debe tumbar la tarea entera.
  try {applyPlanChoices(run,decision.subtasks);}
  catch(error) {pushEvent(run,'No se pudo aplicar tu elección de modelo: '+error.message);}
  return decision;
}

async function prepare(run,decision){
  const project=projectOf(run);
  // Las partes asignadas a personas no se ejecutan: ni copia aislada, ni ola, ni sesión.
  const agents=run.subtasks.filter(subtask=>!subtask.human);
  const writers=agents.filter(subtask=>!subtask.readOnly);
  let info=inspect(project.path);
  // Solo hace falta aislar cuando dos o más sub-tareas escriben. Una sola trabaja en la carpeta real,
  // reanuda su sesión nativa y no necesita parche: exactamente como si el agente trabajara por su cuenta.
  const wantsIsolation=writers.length>1;
  if(wantsIsolation&&info.kind!=='worktree'&&decision.initRepo){
    await initRepository(project.path);
    info=inspect(project.path);
    pushEvent(run,'Se inicializó un repositorio git en la carpeta para poder trabajar en paralelo.');
  }
  const isolated=wantsIsolation&&info.kind==='worktree';
  run.isolation={kind:info.kind,relative:info.relative,reason:info.reason,warnings:[],roots:{},base:null};
  if(isolated){
    const spaces=await createWorkspaces({projectPath:project.path,dataDir,runId:run.id,indexes:writers.map(subtask=>subtask.index)});
    run.isolation.warnings=spaces.warnings;
    run.isolation.roots=Object.fromEntries([...spaces.roots]);
    run.isolation.base=spaces.base;
    for(const subtask of agents)subtask.cwd=spaces.cwds.get(subtask.index)||project.path;
  } else {
    for(const subtask of agents)subtask.cwd=project.path;
    // Con el escritor en la carpeta real, el diff desde este punto es la evidencia que verá el revisor.
    run.snapshot=writers.length?snapshotProject(project.path):null;
  }
  if(wantsIsolation&&!isolated)pushEvent(run,'La carpeta no es un repositorio git: las sub-tareas que escriben se ejecutan de una en una.');
  // Una sola sub-tarea para el mismo agente que planificó: la hace él en su sesión, que ya conoce el proyecto.
  const only=agents.length===1?agents[0]:null;
  if(only&&only.provider===run.orchestrator.provider&&run.orchestrator.sessionId&&only.cwd===project.path)only.self=true;
  run.waves=assignWaves(agents,{isolated,maxParallel:maxParallel()});
  if(coopEnabled(project))void coopBackfillRun(run,project).catch(()=>{});
  flush();
}

// `options.kind`: 'work' (una sub-tarea del plan), 'self' (el arquitecto la hace en su propia sesión),
// 'direct' (modo directo, sin arquitecto) o 'fix' (corrección que reanuda la sesión de la sub-tarea).
// `options.prompt` sustituye el prompt (segunda opinión); `options.messageKind` y `options.stage` etiquetan el mensaje.
async function runSubtask(run,subtask,controller,options=null){
  const conv=store.conversation(run.conversationId),project=store.project(conv.projectId);
  const kind=options?.kind||'work';
  const direct=subtask.cwd===project.path;
  const stageLabel=options?.stage||(kind==='fix'?`Corrección: ${subtask.title}`:kind==='direct'?'Directo':subtask.title);
  subtask.status='running';subtask.stage=kind==='fix'?'Corrigiendo':subtask.readOnly?'Investigando':'Trabajando';
  subtask.startedAt=now();subtask.finishedAt=null;subtask.error=null;rollup(run);
  const current=message(conv.id,'assistant','',{provider:subtask.provider,model:subtask.model,status:'streaming',
    runId:run.id,subtaskId:subtask.id,kind:options?.messageKind||(kind==='direct'?'direct':'work'),stage:stageLabel});
  subtask.messageId=current.id;flush();
  if(kind==='self')pushEvent(run,'Una sola sub-tarea para el mismo agente: el arquitecto la hace en su propia sesión, sin arrancar otro proceso en frío.');
  const instructions=store.data.settings[subtask.provider+'Instructions']||'';
  // A native session belongs to one working folder: resuming it from an isolated copy would mix contexts.
  // En modo directo la sesión es de la conversación y del agente, no del modelo: cambiar de modelo no la pierde.
  const key=kind==='work'&&direct?sessionKey(subtask):kind==='direct'?`direct:${subtask.provider}:${subtask.readOnly?'read':'work'}`:null;
  subtask.sessionKey=key;
  const sessionId=kind==='fix'?subtask.sessionId:kind==='self'?run.orchestrator.sessionId:(key?conv.sessions?.[key]:undefined);
  let prompt;
  if(options?.prompt)prompt=options.prompt;
  else if(kind==='fix')prompt=buildFixPrompt({request:run.prompt,subtask,review:run.review?.summary||'',feedback:options?.feedback||''});
  else if(kind==='self')prompt=buildSelfPrompt({subtask});
  else{
    const memory=memoryContext({...store.data,memories:sharedMemories(store.data)},project.id,conv.id,subtask.instructions);
    if(kind==='direct'){
      const prior=store.data.messages.filter(m=>m.conversationId===conv.id&&m.runId!==run.id&&m.status!=='error').slice(-12);
      const history=prior.map(m=>`${m.provider||m.role}: ${m.content}`).join('\n\n').slice(-24000);
      prompt=buildDirectPrompt({request:run.prompt,memory,instructions,history,readOnly:subtask.readOnly,resumed:!!sessionId});
    } else {
      const teamNote=run.subtasks.filter(other=>other.human).map(other=>`- ${other.personName}: ${other.title}`).join('\n');
      prompt=buildWorkPrompt({request:run.prompt,subtask,memory,instructions,context:run.plan.context,direct,teamNote});
    }
  }
  const providerOptions=sid=>({
    cwd:subtask.cwd,model:subtask.model,effort:subtask.effort,prompt,readOnly:subtask.readOnly,
    sessionId:sid,signal:controller.signal,onSession:next=>{subtask.sessionId=next;touch();},
    allowedTools:claudeAllowedTools(project.allowedCommands),allowCommand:allowCommandIn(project),attachments:kind==='direct'?run.attachments:undefined,
    extraTools:subtask.readOnly?['Bash']:undefined,
    onText:text=>{current.content=text;touch();},
    onEvent:text=>{subtask.events.push({time:now(),text:String(text).slice(0,1500)});subtask.events=subtask.events.slice(-40);touch();},
    approve:request=>ask(run,subtask,request,controller.signal)
  });
  try{
    let result;
    try{result=await runProvider(subtask.provider,providerOptions(sessionId));}
    catch(error){
      if(!sessionId||controller.signal.aborted||!looksLikeSessionLoss(error))throw error;
      pushEvent(run,`${subtask.title}: la sesión nativa no se pudo reanudar; empieza una nueva.`);
      if(kind==='self')run.orchestrator.sessionId=null;
      result=await runProvider(subtask.provider,providerOptions(undefined));
    }
    if(controller.signal.aborted)throw new Error('Tarea detenida.');
    if(!result.text?.trim())throw new Error('El agente terminó sin devolver texto. Revisa la actividad e inténtalo de nuevo.');
    if(result.sessionId)subtask.sessionId=result.sessionId;
    if(key&&result.sessionId)rememberSession(conv,key,result.sessionId);
    if(kind==='self'&&result.sessionId)run.orchestrator.sessionId=result.sessionId;
    connections[subtask.provider].verifiedAt=now();
    current.content=result.text;current.status='completed';current.stage=stageLabel;current.usage=result.usage;
    addUsage(run,result.usage);
    subtask.text=result.text.slice(0,20000);subtask.usage=result.usage;subtask.status='completed';subtask.stage='Completado';
    if(result.permissionDenials?.length)pushEvent(run,`${subtask.title}: algunas herramientas no recibieron permiso.`);
    const workspace=run.isolation?.roots?.[subtask.index];
    if(!subtask.readOnly){
      if(workspace)subtask.patch=await capturePatch({worktreeRoot:workspace,patchPath:path.join(dataDir,'patches',run.id,`${subtask.index}.patch`)});
      else if(run.snapshot)subtask.diff=await diffSince({projectPath:project.path,snapshot:run.snapshot,patchPath:path.join(dataDir,'patches',run.id,`${subtask.index}.direct.diff`)});
    }
  }catch(error){
    // A subtask-specific abort carries a reason object; a run-wide cancel or a real failure does not.
    const reason=controller.signal.aborted?controller.signal.reason:null;
    const byArchitect=reason?.architect===true,byBudget=reason?.budget===true,bySteer=reason?.steer===true;
    subtask.status=byArchitect?'stopped':controller.signal.aborted?'cancelled':'error';
    subtask.stage=byArchitect?'Detenida por el arquitecto':byBudget?'Detenida por tope de consumo':bySteer?'Redirigido':'Sin completar';
    subtask.error=byArchitect?reason.motivo:byBudget?`La tarea superó el tope de ${reason.limit} tokens.`:bySteer?'':(noteAuthFailure(subtask.provider,error.message)||error.message);
    current.status=subtask.status;current.error=subtask.error||null;current.stage=subtask.stage;
    if(current.content.trim()===error.message.trim())current.content='';
  }finally{subtask.finishedAt=now();rollup(run);flush();}
}

async function reviewPhase(run,controller){
  const conv=store.conversation(run.conversationId),project=store.project(conv.projectId);
  // Una única sub-tarea de consulta ya es la respuesta: revisarla sería pagar un turno por repetirla.
  if(run.subtasks.length===1&&run.subtasks[0].readOnly){run.review=null;return;}
  run.phase='review';run.status='reviewing';run.stage='Revisando';flush();
  // Al revisar de nuevo tras una integración, los parches ya están en la carpeta: no se vuelven a comprobar.
  const alreadyApplied=(run.review?.integration?.applied?.length||0)>0;
  const patches=alreadyApplied?[]:run.subtasks.map(subtask=>subtask.patch).filter(Boolean);
  const excludes=patchExcludesOf(run);
  const verified=patches.length?await checkPatches({projectPath:project.path,patches,excludes}):{ok:true,failures:[],overlaps:[]};
  const patchText={};
  if(!alreadyApplied)for(const subtask of run.subtasks){const change=subtask.patch||subtask.diff;if(change?.file){try{patchText[subtask.id]=fs.readFileSync(change.file,'utf8');}catch{}}}
  // El revisor juzga el resultado integrado: una copia con todos los parches aplicados, o la carpeta
  // real si el trabajo ya está ahí. Solo si nada de eso es posible juzga desde el informe.
  let cwd=project.path,workspace=patches.length?'project-clean':'project';
  if(patches.length&&verified.ok){
    try{
      const review=await createReviewWorkspace({projectPath:project.path,dataDir,runId:run.id,base:run.isolation?.base,patches});
      cwd=review.cwd;workspace='integrated';
      for(const warning of review.warnings)pushEvent(run,warning);
    }catch(error){pushEvent(run,'No se pudo preparar la copia de revisión; el revisor juzga desde el proyecto: '+error.message);}
  }else if(!patches.length&&run.subtasks.some(subtask=>subtask.diff))workspace='project-direct';
  const current=message(conv.id,'assistant','',{provider:run.orchestrator.provider,model:run.orchestrator.model,
    status:'streaming',runId:run.id,subtaskId:null,kind:'review',stage:'Revisión'});
  flush();
  const reviewer={id:'review:'+run.id,index:-1,title:'Revisión',model:run.orchestrator.model,provider:run.orchestrator.provider,status:'running'};
  const turn=where=>orchestratorRun(run,{controller,cwd:where,extraTools:['Bash'],allowedTools:[...REVIEW_ALLOWED,...claudeAllowedTools(project.allowedCommands)],
    allowCommand:allowCommandIn(project),approve:request=>ask(run,reviewer,request,controller.signal,`Revisión · ${run.orchestrator.model}`),
    onText:text=>{current.content=text;touch();},
    prompt:buildReviewPrompt({request:run.prompt,subtasks:run.subtasks,overlaps:verified.overlaps,failures:verified.failures,patchText,workspace})});
  let result;
  try{result=await turn(cwd);}
  catch(error){
    // Si la sesión nativa no admite cambiar de carpeta, se repite la revisión desde el proyecto.
    if(cwd===project.path||controller.signal.aborted)throw error;
    pushEvent(run,'La revisión en la copia integrada falló; se repite desde el proyecto: '+error.message);
    cwd=project.path;workspace='project-clean';
    result=await turn(cwd);
  }
  current.content=result.text;current.status='completed';current.stage='Revisión';current.usage=result.usage;
  const verdict=readVerdict(result.text);
  run.review={messageId:current.id,summary:String(result.text||'').slice(0,8000),
    status:verdict.integrate?'integrar':'no-integrar',integration:alreadyApplied?run.review.integration:null,workspace};
  if(!patches.length){flush();return;}
  run.status='integrating';run.stage='Integrando';flush();
  if(verdict.integrate&&verified.ok){
    run.review.integration=await applyPatches({projectPath:project.path,patches,excludes});
    pushEvent(run,run.review.integration.conflicts.length?'La integración no se aplicó: hay conflictos.'
      :`Se integraron los cambios de ${run.review.integration.applied.length} sub-tarea(s).`);
  }else{
    run.review.integration={applied:[],conflicts:verified.failures.length?verified.failures
      :[{file:'—',reason:verdict.explicit?'El revisor no autorizó la integración.':'El revisor no dejó un veredicto claro; no se integró nada.'}]};
    pushEvent(run,'Los cambios quedaron sin integrar. Revisa el informe y decide desde la conversación.');
  }
  flush();
}

function recordRunMemory(run){
  const conv=store.conversation(run.conversationId),project=store.project(conv.projectId);
  // One consolidated record per run: one per sub-task would crowd every other project out of the recall slots.
  const body=[`Tarea: ${run.prompt.slice(0,2000)}`,
    run.answer?`Respuesta directa (${run.orchestrator.provider} ${run.orchestrator.model}):\n${run.answer.slice(0,6000)}`:'',
    run.plan.summary?`Plan (${run.orchestrator.provider} ${run.orchestrator.model}): ${run.plan.summary}`:'',
    ...run.subtasks.map(subtask=>subtask.human
      ?`${subtask.title} · ${subtask.personName} (persona) · ${humanStatusLabel(subtask.status)}${subtask.due?` · fecha límite ${subtask.due}`:''}:\n${String(subtask.result||'sin resultado anotado').slice(0,2500)}`
      :`${subtask.title} · ${subtask.provider} ${subtask.model} · ${subtask.status}:\n${String(subtask.text||subtask.error||'').slice(0,2500)}`),
    run.review?.summary?`Revisión del orquestador:\n${run.review.summary.slice(0,2500)}`:''].filter(Boolean).join('\n\n');
  // Una corrección actualiza el registro de su tarea en vez de añadir otro.
  const existing=store.data.memories.find(m=>m.automatic&&m.runId===run.id);
  if(existing){existing.content=body.slice(0,12000);existing.updatedAt=now();return;}
  store.data.memories.push({id:id(),runId:run.id,projectId:project.id,conversationId:conv.id,provider:run.orchestrator.provider,
    automatic:true,createdAt:now(),title:conv.title,content:body.slice(0,12000)});
}

// Runs inside settle(): it must never throw, or the run would end without saving.
async function finishWorkspaces(run){
  try{
    // Keep the isolated copies while changes are still waiting to be integrated by hand, or to be corrected.
    const pending=run.subtasks.some(subtask=>subtask.patch)&&!run.review?.integration?.applied?.length;
    if(pending&&run.status!=='cancelled')return;
    await removeWorkspaces({projectPath:projectOf(run).path,dataDir,runId:run.id});
  }catch(error){console.error('No se pudieron limpiar las copias de trabajo:',error.message);}
}

// Una sub-tarea se puede corregir mientras exista su sesión nativa y la carpeta donde trabajó.
function markFixable(run){
  const project=projectOf(run);
  for(const subtask of run.subtasks||[]){
    subtask.fixable=!['directo','opinion'].includes(run.mode)&&!subtask.human&&!!subtask.sessionId&&!subtask.readOnly&&['completed','error','stopped'].includes(subtask.status)
      &&(subtask.cwd===project.path||(!!subtask.cwd&&fs.existsSync(subtask.cwd)));
  }
  touch();
}

const MAX_SUPERVISION=()=>Math.max(1,Number(process.env.MIXTO_MAX_SUPERVISION)||12);

// One architect turn at a time, never overlapping and never while planning or reviewing: `state.chain`
// serializes every call this run makes, and `state.turns` caps how many of them reach the architect.
async function superviseWave(run,events,writers,controllers,runController,state){
  if(runController.signal.aborted||run.phase!=='work')return;
  for(const event of events)pushEvent(run,event.type==='colision'
    ?`Aviso: varias sub-tareas han modificado «${event.file}».`
    :`Aviso: la sub-tarea #${event.index+1} ha tocado «${event.file}», fuera de su alcance.`);
  if(state.turns>=MAX_SUPERVISION()){pushEvent(run,'Se alcanzó el límite de consultas al arquitecto; se sigue vigilando sin preguntarle.');return;}
  state.turns++;
  try{
    const result=await orchestratorRun(run,{controller:runController,onText:()=>{},
      prompt:buildSupervisionPrompt({events,subtasks:writers})});
    const decision=parseDecision(result.text);
    if(decision.action!=='detener'){pushEvent(run,'El arquitecto revisó el aviso y decidió seguir.');return;}
    const target=writers.find(subtask=>subtask.index+1===decision.subtask);
    const abort=target?.status==='running'&&controllers.get(target.id);
    if(!abort){pushEvent(run,`El arquitecto pidió detener la sub-tarea #${decision.subtask}, pero ya no está en marcha.`);return;}
    pushEvent(run,`El arquitecto detiene la sub-tarea #${target.index+1} (${target.title}): ${decision.reason||'sin motivo indicado.'}`);
    abort.abort({architect:true,motivo:decision.reason||'El arquitecto detuvo esta sub-tarea.'});
  }catch(error){pushEvent(run,'La supervisión del arquitecto falló: '+error.message);}
}

async function runWaves(run,controller){
  const controllers=new Map(),supervision={chain:Promise.resolve(),turns:0};
  for(const wave of run.waves){
    if(controller.signal.aborted)throw new Error('Tarea detenida.');
    const tasks=wave.map(subtaskId=>run.subtasks.find(subtask=>subtask.id===subtaskId));
    for(const subtask of tasks){
      const sub=new AbortController();
      controller.signal.addEventListener('abort',()=>sub.abort(controller.signal.reason),{once:true});
      controllers.set(subtask.id,sub);
    }
    const writers=tasks.filter(subtask=>!subtask.readOnly);
    const isolated=run.isolation?.kind==='worktree'&&Object.keys(run.isolation.roots||{}).length>0;
    let watcher=null;
    // Live supervision only makes sense when several writers share isolated copies to step on each other's toes.
    if(isolated&&writers.length>1){
      const roots=new Map(writers.map(subtask=>[subtask.index,run.isolation.roots[subtask.index]]));
      watcher=new Watcher({roots,subtasks:writers,onEvents:events=>{
        supervision.chain=supervision.chain.then(()=>superviseWave(run,events,writers,controllers,controller,supervision));
      }});
      watcher.start();
    }
    await Promise.allSettled(tasks.map(subtask=>runSubtask(run,subtask,controllers.get(subtask.id),subtask.self?{kind:'self'}:null)));
    watcher?.stop();
    await supervision.chain.catch(()=>{});
  }
}

async function conclude(run,controller){
  if(controller.signal.aborted)throw new Error('Tarea detenida.');
  const agents=run.subtasks.filter(subtask=>!subtask.human);
  // Una tarea solo de personas no tiene nada que revisar todavía: se revisa cuando ellas terminen.
  const policy=store.data.settings.reviewPolicy||'multi';
  // En reparto a mano manda la casilla del usuario; en el resto, la política de revisión de los ajustes.
  const skip=run.mode==='manual'?run.reviewWanted===false:(!run.reviewRequested&&(policy==='never'||(policy==='multi'&&agents.length<2)));
  if(!agents.length&&!run.reviewRequested)run.review=null;
  else if(skip){await skipReview(run);if(agents.length===1&&policy==='multi')pushEvent(run,'Una sola parte: sin revisión automática (ajustable en Agentes y ajustes). Usa «Ver cambios» o pide una segunda opinión.');}
  else await reviewPhase(run,controller);
  const failed=agents.some(subtask=>subtask.status==='error');
  run.status=failed?'error':'completed';run.stage='Completado';run.error=null;
  if(failed)run.error='Alguna sub-tarea no pudo terminar. Revisa el informe antes de dar el trabajo por hecho.';
  humansRollup(run);
  recordRunMemory(run);
}

// Reparto manual sin revisor: los parches se comprueban y quedan a la espera de que el usuario decida.
async function skipReview(run){
  const project=projectOf(run);
  const patches=run.subtasks.map(subtask=>subtask.patch).filter(Boolean);
  if(!patches.length){run.review=null;return;}
  run.phase='review';run.status='integrating';run.stage='Comprobando';flush();
  const verified=await checkPatches({projectPath:project.path,patches});
  run.review={messageId:null,summary:'',status:'sin-revisar',workspace:null,integration:{applied:[],conflicts:verified.failures}};
  pushEvent(run,verified.ok?'Sin revisión automática: aplica o descarta los cambios desde la conversación.'
    :'Sin revisión automática: hay parches que no aplican limpios. Revisa el informe y corrige o descarta.');
  flush();
}

function failRun(run,controller,error){
  const reason=controller.signal.aborted?controller.signal.reason:null;
  run.status=controller.signal.aborted?'cancelled':'error';
  run.error=reason?.steer===true?null:reason?.budget===true
    ?`La tarea se detuvo al superar el tope de ${reason.limit} tokens (llevaba ${reason.total}). Sube el tope en Agentes, corrige una sub-tarea o vuelve a pedirla.`
    :(noteAuthFailure(run.orchestrator.provider,error.message)||error.message);
  run.stage=reason?.steer===true?'Redirigido':reason?.budget===true?'Detenida por tope de consumo':'Sin completar';
  for(const message of store.data.messages)if(message.runId===run.id&&message.status==='streaming'){
    message.status=run.status;message.stage=run.stage;message.error=run.error;
  }
}

async function settle(run){
  run.phase='done';run.finishedAt=now();active.delete(run.id);planGates.delete(run.id);
  for(const [key,approval] of approvals)if(approval.public.runId===run.id){approval.resolve({allow:false});approvals.delete(key);}
  await finishWorkspaces(run);
  markFixable(run);
  flush();
  void syncMemory();
  void refreshLimits();
  try{void refreshChanges(projectOf(run));}catch{}
}

async function execute(run,controller){
  try{
    if(run.mode==='directo'||run.mode==='opinion'){await directPhase(run,controller);return;}
    let decision;
    if(run.mode==='manual'){decision={approve:true,initRepo:run.initRepo===true,subtasks:[]};run.status='running';run.stage='Preparando';flush();}
    else{
      decision=await planPhase(run,controller);
      if(!decision){run.status='cancelled';run.stage='Plan descartado';return;}
      if(decision.direct){run.status='completed';run.stage='Respondido';recordRunMemory(run);return;}
    }
    run.stage='Preparando';flush();
    await prepare(run,decision);
    run.phase='work';rollup(run);run.stage='Trabajando';flush();
    await runWaves(run,controller);
    await conclude(run,controller);
  }catch(error){failRun(run,controller,error);}
  finally{await settle(run);}
}

// Modo directo: un solo agente en la carpeta real, con sesión continua, sin plan ni revisión.
// La segunda opinión es un turno directo de solo lectura sobre los cambios sin confirmar del proyecto.
async function directPhase(run,controller){
  const project=projectOf(run);
  const opinion=run.mode==='opinion';
  run.phase='work';run.stage='Trabajando';run.plan={status:'direct-mode',summary:'',warnings:[],context:''};
  const subtask=toSubtask({title:opinion?'Segunda opinión':'Directo',role:opinion?'Revisar los cambios sin confirmar':'Responder o resolver la petición',instructions:run.prompt,justification:'',
    provider:run.orchestrator.provider,model:run.orchestrator.model,effort:run.orchestrator.effort,scope:[],readOnly:opinion||run.readOnly===true,order:1},0);
  subtask.cwd=project.path;run.subtasks=[subtask];run.waves=[[subtask.id]];rollup(run);
  // Con escritura, el diff desde aquí es lo que se muestra en «Ver cambios» y lo que «Deshacer» revierte.
  if(!subtask.readOnly)run.snapshot=snapshotProject(project.path);
  flush();
  let options={kind:'direct'};
  if(opinion){
    const changes=await projectChanges(project.path);
    if(!changes.git)throw new Error('La carpeta no es un repositorio git: no hay cambios sin confirmar que revisar.');
    if(!changes.files.length)throw new Error('No hay cambios sin confirmar que revisar.');
    options={kind:'direct',messageKind:'opinion',stage:'Segunda opinión',
      prompt:buildOpinionPrompt({focus:run.focus||'',status:changes.status,diff:changes.diff,untracked:changes.untracked,truncated:!!changes.truncated})};
  }
  await runSubtask(run,subtask,controller,options);
  if(controller.signal.aborted)throw new Error('Tarea detenida.');
  run.review=null;
  run.status=subtask.status==='completed'?'completed':'error';
  run.stage=run.status==='completed'?'Respondido':'Sin completar';
  if(run.status==='error')run.error=subtask.error;
  recordRunMemory(run);
}

// Corregir una sub-tarea y volver a revisar el conjunto, sin replanificar ni repetir las demás.
async function continueRun(run,subtask,feedback,controller){
  try{
    run.phase='work';run.status='running';run.stage='Corrigiendo';run.error=null;run.finishedAt=null;run.budgetExceeded=false;
    flush();
    await runSubtask(run,subtask,controller,{kind:'fix',feedback});
    await conclude(run,controller);
  }catch(error){failRun(run,controller,error);}
  finally{await settle(run);}
}

async function integrateNow(run,discard){
  const project=projectOf(run);
  if(discard){
    await removeWorkspaces({projectPath:project.path,dataDir,runId:run.id});
    for(const subtask of run.subtasks)subtask.patch=null;
    run.review={...(run.review||{}),integration:{applied:[],conflicts:[],discarded:true}};
    markFixable(run);flush();return {ok:true,discarded:true};
  }
  if(run.review?.integration?.applied?.length)throw new Error('Los cambios de esta tarea ya se integraron.');
  const patches=run.subtasks.map(subtask=>subtask.patch).filter(Boolean);
  if(!patches.length)throw new Error('Esta tarea no dejó cambios pendientes de integrar.');
  const applied=await applyPatches({projectPath:project.path,patches,excludes:patchExcludesOf(run)});
  run.review={...(run.review||{}),integration:applied};
  void refreshChanges(project);
  if(applied.applied.length)await removeWorkspaces({projectPath:project.path,dataDir,runId:run.id});
  markFixable(run);flush();return applied;
}

function assertFolderFree(project){
  for(const [runId] of active){
    const running=getRun(runId);
    if(sameFolder(projectOf(running).path,project.path))throw new Error('Ya hay una tarea en marcha en esta carpeta. Espera a que termine o detenla.');
  }
}

function startRun(body){
  const conv=store.conversation(body.conversationId),project=store.project(conv.projectId);
  const mode=['orquestar','directo','manual','opinion'].includes(body.mode)?body.mode:'orquestar';
  let prompt=mode==='opinion'?str(body.prompt||'','Mensaje',50000,true):str(body.prompt,'Mensaje',50000);
  let autoChoice=null,orchestratorBody=body.orchestrator||{};
  if(orchestratorBody.provider==='auto'){
    autoChoice=chooseAgent({request:prompt,connections,messages:store.data.messages,settings:store.data.settings});
    orchestratorBody={provider:autoChoice.provider,model:autoChoice.model,effort:autoChoice.effort};
  }
  const provider=PROVIDERS.includes(orchestratorBody.provider)?orchestratorBody.provider:'claude';
  const display=typeof body.display==='string'&&body.display.trim()?str(body.display,'Mensaje',50000):null;
  const attachments=(Array.isArray(body.attachments)?body.attachments:[]).map(ref=>store.data.uploads.find(upload=>upload.id===ref)).filter(Boolean).slice(0,8)
    .map(upload=>({id:upload.id,name:upload.name,mime:upload.mime,path:upload.path}));
  // Resolve symlinks and case before locking the workspace across providers.
  project.path=folder(project.path);
  assertFolderFree(project);
  const focus=mode==='opinion'?prompt:'';
  if(mode==='opinion')prompt=`Segunda opinión de ${agentName(provider)} sobre los cambios sin confirmar${focus?`: ${focus}`:''}`;
  const run={id:id(),conversationId:conv.id,prompt,focus,mode,orchestrator:{provider,model:'',effort:null,sessionId:null},
    readOnly:mode==='opinion'||body.readOnly!==false,phase:'plan',status:'planning',stage:'Planificando',createdAt:now(),
    plan:{status:'pending',summary:'',warnings:[],context:''},isolation:null,snapshot:null,answer:null,usage:null,
    subtasks:[],waves:[],review:null,events:[],reviewWanted:true,initRepo:false,attachments};
  if(mode==='orquestar'){
    // El arquitecto reanuda su sesión en la conversación; cada ocho tareas empieza una nueva para que no crezca sin fin.
    const key='architect:'+provider,previous=store.data.runs.filter(candidate=>candidate.conversationId===conv.id&&candidate.mode==='orquestar').length;
    run.orchestrator.sessionId=previous%8===0?null:(conv.sessions?.[key]||null);
  }
  let manualNote='';
  if(mode==='manual'){
    const parsed=parseManualPlan(body.plan,{connections,maxSubtasks:MAX_SUBTASKS,runReadOnly:run.readOnly,people:membersOf(project)});
    run.plan={status:'manual',summary:parsed.summary,warnings:parsed.warnings,context:parsed.context};
    run.subtasks=parsed.subtasks.map(toSubtask);
    run.reviewWanted=parsed.review;run.initRepo=body.plan?.initRepo===true;
    run.status='running';run.stage='Preparando';
    manualNote='\n\n**Reparto a mano:**\n'+run.subtasks.map(subtask=>`- ${subtask.title} · ${assigneeName(subtask)}${subtask.readOnly?' · solo lectura':''}`).join('\n');
  }
  // El agente principal orquesta, responde en directo o revisa el reparto manual; solo hace falta si actúa.
  const needsPrincipal=mode!=='manual'||run.reviewWanted;
  if(needsPrincipal&&!connections[provider].connected)throw new Error(`${agentName(provider)} no está conectado. Abre Conexiones para comprobarlo.`);
  if(needsPrincipal)Object.assign(run.orchestrator,modelChoice(provider,orchestratorBody.model,orchestratorBody.effort));
  else run.orchestrator.model=typeof orchestratorBody.model==='string'?orchestratorBody.model.slice(0,200):'';
  if(autoChoice){run.orchestrator.auto=true;run.orchestrator.reason=autoChoice.reason;pushEvent(run,autoChoice.reason);}
  // Sub-tareas del reparto a mano asignadas a «Auto»: se resuelven una a una con sus propias instrucciones.
  for(const subtask of run.subtasks)if(subtask.provider==='auto'){
    const choice=chooseAgent({request:subtask.instructions,connections,messages:store.data.messages,settings:store.data.settings});
    Object.assign(subtask,{provider:choice.provider,model:choice.model,effort:choice.effort,auto:true,magnitude:choice.magnitude,justification:choice.reason});
    pushEvent(run,`#${subtask.index+1} ${subtask.title}: ${choice.reason}`);
  }
  if(conv.title==='Nueva conversación')conv.title=prompt.slice(0,70);
  conv.updatedAt=now();
  message(conv.id,'user',(display||prompt)+manualNote,{runId:run.id,...(mode==='manual'?{kind:'manual'}:{}),
    ...(attachments.length?{attachments:attachments.map(upload=>({id:upload.id,name:upload.name,mime:upload.mime}))}:{})});
  store.data.runs.push(run);
  const controller=new AbortController();active.set(run.id,controller);flush();
  setImmediate(()=>execute(run,controller).catch(e=>console.error(e)));
  return run;
}

function startFix(body){
  const run=getRun(body.runId);
  if(active.has(run.id))throw new Error('Espera a que la tarea termine para corregirla.');
  if(run.phase!=='done')throw new Error('Esta tarea todavía no ha terminado.');
  const subtask=run.subtasks.find(candidate=>candidate.id===body.subtaskId);
  if(!subtask)throw new Error('Sub-tarea no encontrada.');
  markFixable(run);
  if(!subtask.fixable)throw new Error('Esa sub-tarea ya no se puede corregir: su sesión o su copia de trabajo ya no existen.');
  const conv=store.conversation(run.conversationId),project=store.project(conv.projectId);
  project.path=folder(project.path);
  assertFolderFree(project);
  if(!connections[subtask.provider].connected)throw new Error(`${agentName(subtask.provider)} no está conectado. Abre Conexiones para comprobarlo.`);
  if(!connections[run.orchestrator.provider].connected)throw new Error(`${agentName(run.orchestrator.provider)} no está conectado y es quien revisa.`);
  const feedback=str(body.feedback||'','Indicaciones',8000,true);
  conv.updatedAt=now();
  message(conv.id,'user',`Corregir «${subtask.title}»${feedback?`: ${feedback}`:''}`,{runId:run.id,kind:'fix'});
  const controller=new AbortController();active.set(run.id,controller);
  run.status='running';run.stage='Corrigiendo';flush();
  setImmediate(()=>continueRun(run,subtask,feedback,controller).catch(e=>console.error(e)));
  return run;
}

// Revisar de nuevo cuando las personas hayan terminado su parte, o tras corregir a mano: solo la revisión.
function startReview(body){
  const run=getRun(body.runId);
  if(active.has(run.id))throw new Error('Espera a que la tarea termine para revisarla de nuevo.');
  if(run.phase!=='done')throw new Error('Esta tarea todavía no ha terminado.');
  if(run.mode==='directo'||run.mode==='opinion')throw new Error('El modo directo no tiene revisión: sigue conversando.');
  const conv=store.conversation(run.conversationId),project=store.project(conv.projectId);
  project.path=folder(project.path);
  assertFolderFree(project);
  const provider=run.orchestrator.provider;
  if(!connections[provider].connected)throw new Error(`${agentName(provider)} no está conectado y es quien revisa.`);
  Object.assign(run.orchestrator,modelChoice(provider,body.model||run.orchestrator.model,body.effort===undefined?run.orchestrator.effort:body.effort));
  conv.updatedAt=now();
  message(conv.id,'user','Revisar de nuevo el conjunto de la tarea.',{runId:run.id,kind:'review-request'});
  const controller=new AbortController();active.set(run.id,controller);
  run.status='reviewing';run.stage='Revisando';run.reviewWanted=true;run.reviewRequested=true;flush();
  setImmediate(()=>reviewAgain(run,controller).catch(e=>console.error(e)));
  return run;
}
async function reviewAgain(run,controller){
  try{
    run.phase='review';run.error=null;run.finishedAt=null;run.budgetExceeded=false;flush();
    await conclude(run,controller);
  }catch(error){failRun(run,controller,error);}
  finally{await settle(run);}
}

async function bodyJson(req,limit=1024*1024){let bytes=0,chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>limit)throw new Error('La solicitud es demasiado grande.');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}
function json(res,status,data,extra={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra});res.end(JSON.stringify(data));}

const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try{
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host))return json(res,403,{error:'Host no permitido.'});
    const requestOrigin=req.headers.origin;
    if(requestOrigin&&![origin,`http://localhost:${port}`].includes(requestOrigin))return json(res,403,{error:'Origen no permitido.'});
    if(req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'Acceso externo no permitido.'});
    const url=new URL(req.url,origin),route=url.pathname;
    if(route==='/api/health'&&req.method==='GET')return json(res,200,{app:'mixto',version:VERSION});
    if(route.startsWith('/api/')){
      const cookie=req.headers.cookie||'';
      if(!cookie.split(';').some(c=>c.trim()===`mixto_session=${secret}`))return json(res,401,{error:'Recarga Mixto para conectar con la sesión local.'});
      if(req.method!=='GET'&&req.headers['x-mixto-client']!=='1')return json(res,403,{error:'Solicitud no autorizada.'});
      if(route==='/api/state'&&req.method==='GET'){
        const focus=url.searchParams.get('conversation');
        return json(res,200,focus===null?snapshot():snapshot(focus||null,{all:false}));
      }
      if(route==='/api/search'&&req.method==='GET'){
        const q=String(url.searchParams.get('q')||'').trim().toLowerCase(),projectId=url.searchParams.get('projectId');
        if(!q)return json(res,200,{ids:[]});
        const ids=store.data.conversations.filter(c=>(!projectId||c.projectId===projectId)&&(String(c.title||'').toLowerCase().includes(q)||store.data.messages.some(m=>m.conversationId===c.id&&String(m.content||'').toLowerCase().includes(q)))).map(c=>c.id);
        return json(res,200,{ids});
      }
      if(route==='/api/events'&&req.method==='GET'){
        const focus=url.searchParams.get('conversation')||null;
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
        res.write('retry: 2000\n\n');
        res.write(`event: state\ndata: ${JSON.stringify(snapshot(focus,{all:false}))}\n\n`);
        clients.set(res,focus);
        req.on('close',()=>clients.delete(res));
        return;
      }
      if(route==='/api/export'&&req.method==='GET')return json(res,200,store.data,{'Content-Disposition':'attachment; filename="mixto-copia.json"'});
      if(route==='/api/diff'&&req.method==='GET')return json(res,200,diffOf(url.searchParams.get('runId'),url.searchParams.get('subtaskId')));
      if(route==='/api/changes'&&req.method==='GET'){
        const project=store.project(url.searchParams.get('projectId'));
        const changes=await projectChanges(project.path);
        changesCache.set(project.id,{git:changes.git,files:changes.files.length,at:now()});
        return json(res,200,{git:changes.git,files:changes.files,untracked:changes.untracked,diff:changes.diff,truncated:!!changes.truncated,parsed:parseDiff(changes.diff)});
      }
      const b=await bodyJson(req,route==='/api/upload'?9*1024*1024:1024*1024);
      if(route==='/api/connections'&&req.method==='POST'){void refreshConnections();return json(res,202,{ok:true});}
      if(route==='/api/memory-sync'&&req.method==='POST'){
        if(active.size)return json(res,409,{error:'Espera a que terminen las tareas activas para sincronizar.'});
        void syncMemory();return json(res,202,{ok:true});
      }
      if(route==='/api/projects'&&req.method==='POST'){
        let directoryName=b.directoryName;
        if(!directoryName&&b.path){
          const supplied=folder(b.path),managed=managedProjectPath(managedProjectsRoot,path.basename(supplied));
          if(!sameFolder(supplied,managed))throw new Error('La carpeta del proyecto debe estar dentro de la carpeta de proyectos gestionada.');
          directoryName=path.basename(managed);
        }
        const p=createManagedProject(store.data,managedProjectsRoot,{name:str(b.name,'Nombre',80),directoryName,
          description:str(b.description||'','Descripción',2000,true)});
        flush();return json(res,201,p);
      }
      if(route==='/api/conversations'&&req.method==='POST'){
        store.project(b.projectId);const c={id:id(),projectId:b.projectId,title:'Nueva conversación',sessions:{},createdAt:now(),updatedAt:now()};store.data.conversations.push(c);flush();return json(res,201,c);
      }
      if(route==='/api/memories'&&req.method==='POST'){
        if(b.projectId)store.project(b.projectId);
        const m={id:id(),projectId:b.projectId||null,title:str(b.title||'Recuerdo','Título',100),content:str(b.content,'Recuerdo',12000),automatic:false,createdAt:now()};store.data.memories.push(m);flush();return json(res,201,m);
      }
      if(route.startsWith('/api/memories/')&&['PATCH','DELETE'].includes(req.method)){
        const m=store.data.memories.find(m=>m.id===route.split('/').pop());if(!m)throw new Error('Recuerdo no encontrado.');
        if(req.method==='DELETE')store.data.memories=store.data.memories.filter(x=>x!==m);
        else{m.content=str(b.content,'Recuerdo',12000);m.title=str(b.title||m.title,'Título',100);m.automatic=false;m.updatedAt=now();}
        flush();return json(res,200,{ok:true});
      }
      if(route==='/api/settings'&&req.method==='POST'){
        for(const provider of ['codex','claude'])if(b[provider+'Instructions']!==undefined)store.data.settings[provider+'Instructions']=str(b[provider+'Instructions'],'Instrucciones',8000,true);
        if(b.orchestratorPersona!==undefined){
          const persona=str(b.orchestratorPersona,'Persona',80,true);
          store.data.settings.orchestratorPersona=listPersonas().some(item=>item.id===persona)?persona:'';
        }
        for(const key of ['autoApproveSingle','autoApproveReadOnly'])if(b[key]!==undefined)store.data.settings[key]=b[key]===true;
        if(b.balance!==undefined)store.data.settings.balance=['auto','claude','codex'].includes(b.balance)?b.balance:'auto';
        if(b.modelNotes!==undefined)store.data.settings.modelNotes=str(b.modelNotes,'Notas sobre modelos',4000,true);
        if(b.claudeSoftLimit!==undefined){const limit=Number(b.claudeSoftLimit);store.data.settings.claudeSoftLimit=Number.isFinite(limit)&&limit>0?Math.round(limit):0;}
        if(b.reviewPolicy!==undefined)store.data.settings.reviewPolicy=['multi','always','never'].includes(b.reviewPolicy)?b.reviewPolicy:'multi';
        if(b.tokenBudget!==undefined){
          const budget=Number(b.tokenBudget);
          if(!Number.isFinite(budget)||budget<0)throw new Error('Tope de tokens: escribe un número de tokens, o 0 para no limitar.');
          store.data.settings.tokenBudget=Math.floor(budget);
        }
        flush();return json(res,200,{ok:true});
      }
      if(route==='/api/shutdown'&&req.method==='POST'){json(res,200,{ok:true});stop();return;}
      if(route==='/api/update/check'&&req.method==='POST')return json(res,200,await checkUpdates());
      if(route==='/api/github/connect'&&req.method==='POST'){
        const token=str(b.token,'Token',400).trim();
        if(/\s/.test(token))throw new Error('El token no puede contener espacios.');
        const viewer=await fetchViewer(githubFrom,token);
        store.data.github={token,...viewer,connectedAt:now()};applyAuth(token);repoCache={at:0,repos:[]};
        flush();return json(res,200,githubView());
      }
      if(route==='/api/github/disconnect'&&req.method==='POST'){store.data.github=null;clearAuth();repoCache={at:0,repos:[]};flush();return json(res,200,githubView());}
      if(route==='/api/github/repos'&&req.method==='GET')return json(res,200,{repos:await githubRepos(url.searchParams.get('refresh')==='1')});
      if(route==='/api/github/clone'&&req.method==='POST')return json(res,201,await cloneFromGithub(b));
      if(route==='/api/pull'&&req.method==='POST'){
        const project=store.project(b.projectId);
        if([...active.keys()].some(runId=>{try{return sameFolder(projectOf(getRun(runId)).path,project.path);}catch{return false;}}))throw new Error('Espera a que terminen las tareas de este proyecto.');
        const result=await pullProject(project.path);
        if(!result.ok)throw new Error('No se pudo traer los cambios: '+result.error);
        await refreshChanges(project);return json(res,200,result);
      }
      if(route==='/api/update/apply'&&req.method==='POST')return json(res,200,await applyUpdateNow());
      if(route==='/api/run'&&req.method==='POST')return json(res,202,startRun(b));
      if(route==='/api/fix'&&req.method==='POST')return json(res,202,startFix(b));
      if(route==='/api/review'&&req.method==='POST')return json(res,202,startReview(b));
      if(route==='/api/people'&&req.method==='POST'){
        const person=personFields(b,{id:id(),createdAt:now()});
        store.data.people.push(person);
        if(b.projectId){const project=store.project(b.projectId);project.members||=[];if(!project.members.includes(person.id))project.members.push(person.id);if(coopEnabled(project))void coopUpsert(project,[]).catch(()=>{});}
        flush();return json(res,201,person);
      }
      if(route.startsWith('/api/people/')&&['PATCH','DELETE'].includes(req.method)){
        const person=store.data.people.find(candidate=>candidate.id===route.split('/').pop());if(!person)throw new Error('Persona no encontrada.');
        if(req.method==='DELETE'){
          store.data.people=store.data.people.filter(candidate=>candidate!==person);
          for(const project of store.data.projects)project.members=(project.members||[]).filter(member=>member!==person.id);
        } else Object.assign(person,personFields({...person,...b}),{updatedAt:now()});
        for(const project of store.data.projects)if(coopEnabled(project)&&(project.members||[]).includes(person.id))void coopUpsert(project,[]).catch(()=>{});
        flush();return json(res,200,{ok:true});
      }
      if(route==='/api/members'&&req.method==='POST'){
        const project=store.project(b.projectId);
        const person=store.data.people.find(candidate=>candidate.id===b.personId);if(!person)throw new Error('Persona no encontrada.');
        project.members||=[];
        if(b.remove===true)project.members=project.members.filter(member=>member!==person.id);
        else if(!project.members.includes(person.id))project.members.push(person.id);
        if(coopEnabled(project))void coopUpsert(project,[]).catch(()=>{});
        flush();return json(res,200,{ok:true});
      }
      if(route==='/api/subtask'&&req.method==='POST'){
        const run=getRun(b.runId),project=projectOf(run);
        const subtask=run.subtasks.find(candidate=>candidate.id===b.subtaskId);
        if(!subtask?.human)throw new Error('Solo las sub-tareas asignadas a personas se actualizan a mano.');
        const note=b.result!==undefined?str(b.result,'Resultado',12000,true):undefined;
        await updateHumanPart(project,{run,subtask},{status:b.status,due:b.due!==undefined?String(b.due||'').trim():undefined,note:note&&note!==subtask.result?note:undefined});
        flush();return json(res,200,{ok:true});
      }
      if(route==='/api/assignments'&&req.method==='POST'){
        const project=store.project(b.projectId),coop=coopOf(project);
        const person=membersOf(project).find(candidate=>candidate.id===b.personId);
        if(!person)throw new Error('Elige a una persona del equipo del proyecto.');
        const due=String(b.due||'').trim();
        if(due&&!/^\d{4}-\d{2}-\d{2}$/.test(due))throw new Error('Fecha límite: usa el formato AAAA-MM-DD.');
        const scope=typeof b.scope==='string'?b.scope.split(',').map(entry=>entry.trim()).filter(Boolean).slice(0,20):[];
        const entry={id:id(),project:project.name,title:str(b.title,'Título',120),personId:person.id,personName:person.name,personEmail:person.email||'',
          status:'pendiente',due:due||null,createdBy:coop.identity?.email?`${coop.identity.name} <${coop.identity.email}>`:'Mixto',createdAt:now(),updatedAt:now(),
          task:str(b.task||'','Tarea',300,true),origin:'',instructions:str(b.instructions,'Encargo',12000),scope,context:'',notes:[]};
        if(coopEnabled(project))await coopUpsert(project,[entry]);else cacheAssignment(project,entry);
        flush();return json(res,201,entry);
      }
      if(route.startsWith('/api/assignments/')&&req.method==='PATCH'){
        const project=store.project(b.projectId);coopOf(project);
        const entry=project.assignments.find(candidate=>candidate.id===route.split('/').pop());
        if(!entry)throw new Error('Encargo no encontrado en este proyecto.');
        const note=b.note!==undefined?str(b.note,'Nota',12000,true):undefined;
        await updateHumanPart(project,{assignment:entry},{status:b.status,due:b.due!==undefined?String(b.due||'').trim():undefined,note:note||undefined});
        flush();return json(res,200,{ok:true});
      }
      if(route==='/api/cooperation'&&req.method==='POST'){
        const project=store.project(b.projectId),coop=coopOf(project);
        if(b.autoPublish!==undefined)coop.autoPublish=b.autoPublish===true;
        if(b.enabled===true&&!coop.enabled){
          const info=inspect(project.path);
          if(info.kind!=='worktree')throw new Error('La cooperación por git necesita que la carpeta sea un repositorio git con al menos un commit.');
          coop.enabled=true;coop.error=null;flush();
          void coopEnableNow(project).catch(error=>{coop.error=error.message;touch();});
        } else if(b.enabled===false)coop.enabled=false;
        flush();return json(res,200,{ok:true});
      }
      if(route==='/api/cooperation/sync'&&req.method==='POST'){
        const project=store.project(b.projectId);
        if(!coopEnabled(project))throw new Error('La cooperación por git no está activada en este proyecto.');
        const synced=await coopSync(project,{fetch:b.fetch!==false});
        flush();return json(res,200,{ok:true,fetched:synced.status.fetched,fetchError:synced.status.fetchError,autoDone:synced.autoDone,assignments:project.assignments.length});
      }
      if(route==='/api/cooperation/publish'&&req.method==='POST'){
        const project=store.project(b.projectId);
        if(!coopEnabled(project))throw new Error('La cooperación por git no está activada en este proyecto.');
        const result=await coopSerial(project,()=>coopPublishNow(project));
        flush();return json(res,200,result);
      }
      if(route==='/api/plan'&&req.method==='POST'){
        const gate=planGates.get(b.runId);
        if(!gate)throw new Error('Ese plan ya no está esperando una respuesta.');
        gate({approve:b.approve===true,initRepo:b.initRepo===true,subtasks:b.subtasks});
        return json(res,200,{ok:true});
      }
      if(route==='/api/integrate'&&req.method==='POST'){
        const run=getRun(b.runId);
        if(active.has(run.id))throw new Error('Espera a que la tarea termine para integrar los cambios.');
        return json(res,200,await integrateNow(run,b.discard===true));
      }
      if(route==='/api/cancel'&&req.method==='POST'){
        const controller=active.get(b.id);if(!controller)throw new Error('La tarea ya ha terminado.');controller.abort();return json(res,200,{ok:true});
      }
      if(route.startsWith('/api/approvals/')&&req.method==='POST'){
        const a=approvals.get(route.split('/').pop());if(!a)throw new Error('Esta solicitud ya no está pendiente.');
        // «Permitir siempre»: el prefijo del comando pasa a la lista del proyecto y deja de preguntar.
        if(b.remember===true&&b.allow===true&&a.public.command){
          const project=projectOf(getRun(a.public.runId));
          project.allowedCommands=cleanCommandList([...(project.allowedCommands||[]),commandPrefix(a.public.command)]);
        }
        a.resolve({allow:b.allow===true,answers:b.answers&&typeof b.answers==='object'?b.answers:{}});flush();return json(res,200,{ok:true});
      }
      if(/^\/api\/projects\/[^/]+\/settings$/.test(route)&&req.method==='POST'){
        const project=store.project(route.split('/')[3]);
        if(b.allowedCommands!==undefined){if(!Array.isArray(b.allowedCommands))throw new Error('Comandos permitidos: envía una lista.');project.allowedCommands=cleanCommandList(b.allowedCommands);}
        flush();return json(res,200,{ok:true,allowedCommands:project.allowedCommands||[]});
      }
      if(route==='/api/steer'&&req.method==='POST')return json(res,202,await steerRun(b));
      if(route==='/api/revert'&&req.method==='POST'){
        const run=getRun(b.runId),project=projectOf(run);
        if(active.has(run.id))throw new Error('Espera a que la tarea termine.');
        const subtask=run.subtasks.find(candidate=>candidate.id===b.subtaskId);
        const change=subtask?.patch||subtask?.diff;
        if(!change?.file)throw new Error('Esta parte no dejó cambios que deshacer.');
        const files=(Array.isArray(b.files)?b.files:[]).filter(file=>typeof file==='string'&&file.trim()).slice(0,200);
        const applied=run.review?.integration?.applied||[];
        if(subtask.patch&&!applied.includes(subtask.patch.file)){
          // Parche aún sin integrar: excluir (o volver a incluir) archivos antes de aplicarlo.
          const all=parseDiff(fs.readFileSync(change.file,'utf8')).map(file=>file.path);
          const current=new Set(subtask.patchExcludes||[]);
          for(const file of files.length?files:all){if(b.toggle===true&&current.has(file))current.delete(file);else current.add(file);}
          subtask.patchExcludes=[...current];
          flush();return json(res,200,{ok:true,excluded:subtask.patchExcludes});
        }
        if(subtask.reverted)throw new Error('Este turno ya se deshizo.');
        const result=await revertPatch({projectPath:project.path,patchFile:change.file,includes:files});
        if(!result.ok)throw new Error('No se pudo revertir: '+result.error);
        let toplevel=run.snapshot?.toplevel;
        if(!toplevel){try{toplevel=inspect(project.path).toplevel||project.path;}catch{toplevel=project.path;}}
        for(const created of change.created||[]){
          if(files.length&&!files.includes(created))continue;
          try{fs.rmSync(path.join(toplevel,created),{force:true});}catch{}
        }
        if(files.length)subtask.revertedFiles=[...new Set([...(subtask.revertedFiles||[]),...files])];
        else subtask.reverted=true;
        pushEvent(run,files.length?`Revertido en tu carpeta: ${files.join(', ')}`:`Turno «${subtask.title}» deshecho en tu carpeta.`);
        await refreshChanges(project);
        flush();return json(res,200,{ok:true,reverted:subtask.reverted===true,revertedFiles:subtask.revertedFiles||[]});
      }
      if(route==='/api/exec'&&req.method==='POST'){const project=store.project(b.projectId);return json(res,202,execView(startExec(project,str(b.command,'Comando',2000))));}
      if(route==='/api/exec/stop'&&req.method==='POST'){stopExec(store.project(b.projectId));return json(res,200,{ok:true});}
      if(route==='/api/changes/refresh'&&req.method==='POST'){const project=store.project(b.projectId);await refreshChanges(project);return json(res,200,changesCache.get(project.id)||{git:false,files:0});}
      if(route==='/api/commit/propose'&&req.method==='POST')return json(res,200,await proposeCommit(store.project(b.projectId),b));
      if(route==='/api/commit'&&req.method==='POST'){
        const project=store.project(b.projectId);
        const result=await commitFiles({projectPath:project.path,message:str(b.message,'Mensaje de commit',5000),files:b.files});
        await refreshChanges(project);return json(res,200,result);
      }
      if(route==='/api/push'&&req.method==='POST'){
        const result=await pushBranch(store.project(b.projectId).path);
        if(!result.ok)throw new Error('No se pudo enviar al remoto: '+result.error);
        return json(res,200,result);
      }
      if(route==='/api/upload'&&req.method==='POST'){
        const name=str(b.name,'Nombre',200).replace(/[\\/:*?"<>|]+/g,'_');
        const mime=str(b.mime||'application/octet-stream','Tipo',100).toLowerCase();
        if(!/^(image\/(png|jpeg|gif|webp)|text\/[\w.+-]+|application\/(pdf|json|xml))$/.test(mime))throw new Error('Tipo de archivo no admitido: imágenes PNG, JPEG, GIF o WebP, texto, PDF o JSON.');
        const data=Buffer.from(String(b.data||''),'base64');
        if(!data.length||data.length>6*1024*1024)throw new Error('El archivo debe pesar entre 1 byte y 6 MB.');
        const dir=path.join(dataDir,'uploads');fs.mkdirSync(dir,{recursive:true});
        const record={id:id(),name,mime,size:data.length,createdAt:now()};
        record.path=path.join(dir,`${record.id}-${name}`);
        fs.writeFileSync(record.path,data);
        store.data.uploads.push(record);
        // Se conservan los últimos 200 adjuntos; los archivos de los anteriores se borran.
        while(store.data.uploads.length>200){const old=store.data.uploads.shift();try{fs.rmSync(old.path,{force:true});}catch{}}
        flush();return json(res,201,{id:record.id,name:record.name,mime:record.mime,size:record.size});
      }
      return json(res,404,{error:'Acción no encontrada.'});
    }
    if(req.method!=='GET')return json(res,405,{error:'Método no permitido.'});
    const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/favicon.svg':'favicon.svg','/favicon.ico':'mixto.ico'};
    if(!files[route])return json(res,404,{error:'Página no encontrada.'});
    if(route==='/')res.setHeader('Set-Cookie',`mixto_session=${secret}; HttpOnly; SameSite=Strict; Path=/`);
    const file=path.join(root,'dist',files[route]);
    const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.ico':'image/x-icon'};
    const binary=path.extname(file)==='.ico';
    res.writeHead(200,{'Content-Type':mime[path.extname(file)]+(binary?'':'; charset=utf-8'),'Cache-Control':'no-cache'});res.end(fs.readFileSync(file));
  }catch(e){json(res,400,{error:e.code==='ENOENT'?missingMessage(e):e.message});}
});

// Tras una actualización, el servidor nuevo arranca mientras el anterior aún suelta el puerto: espera un poco.
let listenRetries=process.env.MIXTO_RESTART==='1'?60:0;
server.on('error',e=>{
  if(e.code==='EADDRINUSE'&&listenRetries-->0){setTimeout(()=>server.listen(port,'127.0.0.1'),250);return;}
  console.error(e.code==='EADDRINUSE'?`El puerto ${port} ya está ocupado.`:e.message);process.exit(1);
});
// Los proyectos cooperativos se ponen al día solos: cada minuto en local y cada cinco con el remoto,
// nunca mientras haya una tarea activa en esa carpeta.
let coopTick=0;
const coopTimer=setInterval(()=>{
  coopTick++;
  for(const project of store.data.projects){
    if(!coopEnabled(project))continue;
    if([...active.keys()].some(runId=>{try{return sameFolder(projectOf(getRun(runId)).path,project.path);}catch{return false;}}))continue;
    void coopSync(project,{fetch:coopTick%5===0}).catch(()=>{});
  }
},60000);
coopTimer.unref();
server.listen(port,'127.0.0.1',()=>{console.log(`Mixto · ${origin}`);void refreshConnections();void syncMemory();
  for(const project of store.data.projects)if(coopEnabled(project))void coopSync(project,{fetch:true}).catch(()=>{});
  if(updateFrom.enabled){setTimeout(()=>void checkUpdates(),4000).unref();setInterval(()=>void checkUpdates(),6*60*60*1000).unref();}});
let stopping=false;
// Reinicio tras actualizar: arranca el servidor nuevo (ya con los archivos nuevos) y este proceso se retira.
function restart(){
  if(stopping)return;stopping=true;
  for(const c of active.values())c.abort();
  closeAllSessions();
  flush();
  const logs=path.join(root,'.runtime');fs.mkdirSync(logs,{recursive:true});
  const out=fs.openSync(path.join(logs,'server.log'),'a'),err=fs.openSync(path.join(logs,'server-error.log'),'a');
  const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,detached:true,stdio:['ignore',out,err],env:{...process.env,MIXTO_RESTART:'1'}});
  child.on('error',e=>console.error('No se pudo reiniciar Mixto: '+e.message));child.unref();
  fs.closeSync(out);fs.closeSync(err);
  setTimeout(()=>{for(const client of clients.keys()){try{client.end();}catch{}}server.close();process.exit(0);},300);
}
function stop(){if(stopping)return;stopping=true;for(const c of active.values())c.abort();closeAllSessions();setTimeout(()=>{flush();for(const client of clients.keys()){try{client.end();}catch{}}server.close();process.exit(0);},750);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
