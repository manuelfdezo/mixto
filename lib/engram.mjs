import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {execFile,execFileSync,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';

const exec=promisify(execFile);
const digest=value=>createHash('sha256').update(value).digest('hex');
const stamp=()=>new Date().toISOString();
const fingerprint=record=>digest(JSON.stringify([record.title,record.content]));
const canonical=directory=>{
  const real=fs.realpathSync(directory);
  return process.platform==='win32'?real.toLowerCase():real;
};
// chmod's mode bits are not enforced by Windows ACLs, so a transfer directory holding a full
// Engram export (which can contain raw conversation text) needs an explicit ACL there instead.
function secureDirectory(directory) {
  if(process.platform!=='win32') {fs.chmodSync(directory,0o700);return;}
  try {execFileSync('icacls',[directory,'/inheritance:r','/grant:r',`${os.userInfo().username}:(OI)(CI)F`],{windowsHide:true,stdio:'ignore'});}
  catch {fs.rmdirSync(directory);throw new Error('No se pudo restringir el acceso a la carpeta temporal de Engram. No se exportaron datos.');}
}
// Only one Mixto instance can hold server.lock at a time, so any mixto-transfer-* left in the
// OS temp dir at startup belongs to a run that was killed before its own cleanup ran.
export function cleanupOrphanTransfers() {
  let entries;
  try {entries=fs.readdirSync(os.tmpdir());} catch {return;}
  for(const name of entries) {
    if(!name.startsWith('mixto-transfer-'))continue;
    try {fs.rmSync(path.join(os.tmpdir(),name),{recursive:true,force:true});} catch {}
  }
}

// Use Engram's public import/export and MCP contracts; never write its SQLite schema.
export class EngramClient {
  constructor({binary,dataDir}={}) {
    const installed=path.join(os.homedir(),'go','bin',process.platform==='win32'?'engram.exe':'engram');
    this.binary=binary||process.env.MIXTO_ENGRAM_PATH||(fs.existsSync(installed)?installed:'engram');
    this.dataDir=path.resolve(dataDir||process.env.ENGRAM_DATA_DIR||path.join(os.homedir(),'.engram'));
    this.env={...process.env,ENGRAM_DATA_DIR:this.dataDir,ENGRAM_CLOUD_AUTOSYNC:'0'};
    // Detection must use each project's cwd, not the launching agent's override.
    delete this.env.ENGRAM_PROJECT;
  }
  async transfer(command,payload) {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mixto-transfer-'));
    secureDirectory(directory);
    const file=path.join(directory,'transfer.json');
    fs.writeFileSync(file,payload?JSON.stringify(payload):'',{mode:0o600});
    try {
      await exec(this.binary,[command,file],{env:this.env,windowsHide:true,timeout:30000,maxBuffer:1024*1024});
      if(command==='export') {
        const data=JSON.parse(fs.readFileSync(file,'utf8'));
        if(data.observations===null)data.observations=[];
        if(data.sessions===null)data.sessions=[];
        if(!Array.isArray(data.observations)||!Array.isArray(data.sessions))throw new Error('Formato de exportación Engram no compatible.');
        return data;
      }
    } finally {fs.unlinkSync(file);fs.rmdirSync(directory);}
  }
  export(){return this.transfer('export');}
  import(data){return this.transfer('import',data);}
  async call(cwd,name,args={}) {
    const child=spawn(this.binary,['mcp',`--tools=${name}`],{cwd,env:this.env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    const pending=new Map();let next=0;
    const fail=error=>{for(const request of pending.values())request.reject(error);pending.clear();};
    child.on('error',fail);child.on('exit',()=>fail(new Error('Engram terminó antes de responder.')));
    child.stdin.on('error',fail);child.stderr.resume();
    const lines=createInterface({input:child.stdout});
    lines.on('line',line=>{
      let message;try{message=JSON.parse(line);}catch{return;}
      const request=pending.get(message.id);if(!request)return;
      pending.delete(message.id);
      message.error?request.reject(new Error(message.error.message)):request.resolve(message.result);
    });
    const request=(method,params)=>new Promise((resolve,reject)=>{
      const id=++next;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    });
    const timer=setTimeout(()=>{fail(new Error('Engram no respondió en 15 segundos.'));child.kill();},15000);
    try {
      await request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'mixto',version:'1.0.0'}});
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
      const result=await request('tools/call',{name,arguments:args});
      const text=(result.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
      if(result.isError)throw new Error('Engram rechazó la operación de memoria.');
      try{return JSON.parse(text);}catch{return {result:text};}
    } finally {
      clearTimeout(timer);lines.close();child.stdin.end();
      // This process belongs only to this operation; never stop an agent's MCP process.
      if(child.exitCode===null)child.kill();
    }
  }
}

export function sharedMemories(data) {
  return [...data.memories.filter(m=>!m.engramDeleted),...(data.engram?.cache||[])];
}

export class EngramBridge {
  constructor(store,{client=new EngramClient()}={}) {
    this.store=store;this.client=client;this.running=null;
    this.status={state:'pending',lastSuccess:store.data.engram?.lastSuccess||null,pending:0,error:null};
  }
  sync() {
    if(this.running)return this.running;
    this.running=this.synchronize().catch(error=>{
      this.status={...this.status,state:'offline',error:error.code==='ENOENT'?'No se encuentra Engram. Se conserva la memoria local.':error.message};
    }).finally(()=>{this.running=null;});
    return this.running;
  }
  async synchronize() {
    const data=this.store.data;
    this.status={...this.status,state:'syncing',error:null};
    if(!data.engram) {
      const bytes=fs.readFileSync(this.store.file);
      const backup=this.store.file+'.pre-engram-'+stamp().replace(/[:.]/g,'-')+'.bak';
      fs.writeFileSync(backup,bytes,{flag:'wx',mode:0o600});
      if(digest(fs.readFileSync(backup))!==digest(bytes))throw new Error('La copia de seguridad no coincide. No se migró la memoria.');
      data.engram={instanceId:randomUUID(),backup:{path:backup,sha256:digest(bytes)},projects:{},records:{},cache:[],history:[]};
      this.store.save();
    }
    const state=data.engram,bindings=new Map(),names=new Map();
    // Resolve with precisely the same Go detector the agents use; fail closed on ambiguity/collisions.
    for(const project of data.projects) {
      const resolved=await this.client.call(project.path,'mem_current_project');
      if(!resolved.project||resolved.error_hint)throw new Error(`Proyecto Engram ambiguo: ${project.name}. Revisa su configuración de proyecto.`);
      const root=canonical(resolved.project_path||project.path),previous=state.projects[project.id];
      if(previous&&(previous.name!==resolved.project||previous.root!==root))throw new Error(`Cambió la identidad Engram de ${project.name}. La sincronización está detenida para evitar mezclar proyectos.`);
      if(names.has(resolved.project)&&names.get(resolved.project)!==root)throw new Error(`Dos carpetas distintas comparten el proyecto Engram ${resolved.project}. Asigna nombres de proyecto distintos en Engram.`);
      names.set(resolved.project,root);bindings.set(project.id,{name:resolved.project,root,cwd:project.path});
    }
    const first=bindings.values().next().value;
    if(!first)throw new Error('No hay proyectos para sincronizar.');
    let exported=await this.client.export();
    const remote=new Map(exported.observations.map(o=>[o.sync_id,o]));
    const sessions=[],observations=[],present=new Set();
    const prefix=`mixto:${state.instanceId}:`;
    const add=(kind,record,binding,session,scope='project')=>{
      const key=prefix+kind+':'+record.id;
      present.add(key);
      const target={sync_id:key,session_id:session,type:kind==='message'?'mixto_message':record.automatic?'mixto_work':'manual',title:record.title||'Mixto',content:record.content,project:binding.name,scope,topic_key:key,created_at:record.createdAt||stamp(),updated_at:record.updatedAt||record.createdAt||stamp()};
      observations.push({key,kind,record,binding,target});
    };
    for(const project of data.projects) {
      const binding=bindings.get(project.id),session=prefix+'project:'+project.id;
      sessions.push({id:session,project:binding.name,directory:project.path,started_at:project.createdAt||stamp()});
      for(const note of data.memories.filter(m=>m.projectId===project.id))add('memory',note,binding,session);
    }
    const globalSession=prefix+'global';
    sessions.push({id:globalSession,project:first.name,directory:first.cwd,started_at:stamp()});
    for(const note of data.memories.filter(m=>!m.projectId))add('memory',note,first,globalSession,'personal');
    for(const conversation of data.conversations) {
      const binding=bindings.get(conversation.projectId);if(!binding)throw new Error('Una conversación no tiene un proyecto válido.');
      const session=prefix+'conversation:'+conversation.id;
      sessions.push({id:session,project:binding.name,directory:binding.cwd,started_at:conversation.createdAt||stamp(),summary:conversation.title});
      for(const message of data.messages.filter(m=>m.conversationId===conversation.id&&m.status!=='streaming')) {
        if(!message.content)continue;
        add('message',{...message,title:`${conversation.title} · ${message.provider||message.role} · ${message.status||'saved'}`},binding,session);
      }
    }
    this.status.pending=observations.filter(o=>!state.records[o.key]||state.records[o.key].hash!==fingerprint(o.target)).length;
    const additions=[];
    for(const item of observations) {
      const {key,kind,record,binding,target}=item,prior=state.records[key],existing=remote.get(key);
      if(existing&&(existing.project!==target.project||existing.session_id!==target.session_id))throw new Error('Identidad de memoria Engram inesperada. No se sobrescribió ningún registro.');
      if(!existing) {additions.push(target);continue;}
      if(kind==='memory'&&prior) {
        const localChanged=fingerprint(target)!==prior.hash;
        const remoteChanged=fingerprint(existing)!==prior.hash;
        if(localChanged&&(existing.deleted_at||(remoteChanged&&fingerprint(target)!==fingerprint(existing))))throw new Error(`Conflicto en «${record.title}»: cambió en Mixto y Engram. Se conservan ambas versiones; resuélvelo antes de sincronizar.`);
        if(localChanged&&fingerprint(target)!==fingerprint(existing))await this.client.call(binding.cwd,'mem_update',{id:existing.id,title:target.title,content:target.content,type:target.type});
        else if(remoteChanged||existing.deleted_at) {
          if(remoteChanged&&!existing.deleted_at) {
            state.history.push({...record,archivedAt:stamp(),reason:'engram-update'});
            record.title=existing.title;record.content=existing.content;record.updatedAt=existing.updated_at;
          }
          record.engramDeleted=!!existing.deleted_at;
        }
      }
    }
    // Deletes only target our namespaced records, never agent-owned observations.
    for(const [key,prior] of Object.entries(state.records)) {
      if(prior.kind!=='memory'||present.has(key))continue;
      const existing=remote.get(key);
      if(existing&&!existing.deleted_at) {
        if(existing.project!==prior.project||existing.session_id!==prior.session)throw new Error('No se pudo verificar el propietario del recuerdo eliminado.');
        const binding=[...bindings.values()].find(b=>b.name===prior.project);
        if(!binding)throw new Error('El proyecto del recuerdo eliminado no está disponible.');
        await this.client.call(binding.cwd,'mem_delete',{id:existing.id});
      }
    }
    if(additions.length||sessions.length)await this.client.import({sessions,observations:additions,prompts:[]});
    exported=await this.client.export();
    const verified=new Map(exported.observations.map(o=>[o.sync_id,o]));
    for(const {key,kind,record,target} of observations) {
      const saved=verified.get(key);
      if(!saved)throw new Error('Engram no confirmó todos los recuerdos. Se reintentará sin duplicarlos.');
      const expected=kind==='memory'?record:target;
      if(!saved.deleted_at&&fingerprint(saved)!==fingerprint(expected))throw new Error('Engram no conservó el contenido completo. El original sigue en la copia local.');
      state.records[key]={kind,hash:fingerprint(saved),project:saved.project,session:saved.session_id};
    }
    const cache=[];
    for(const project of data.projects) {
      const binding=bindings.get(project.id);
      for(const observation of exported.observations) {
        // No unscoped/personal agent records, and no other project's content in this project's cache.
        if(observation.project!==binding.name||observation.scope!=='project'||observation.deleted_at||observation.sync_id.startsWith(prefix))continue;
        cache.push({id:`engram:${project.id}:${observation.sync_id}`,projectId:project.id,title:observation.title,content:observation.content,automatic:true,provider:'engram',createdAt:observation.created_at,engramReadOnly:true,needsReview:!!observation.review_after&&Date.parse(observation.review_after)<Date.now()});
      }
    }
    state.cache=cache;state.projects=Object.fromEntries(bindings);state.lastSuccess=stamp();
    this.store.save();
    this.status={state:'synced',lastSuccess:state.lastSuccess,pending:0,error:null};
  }
}
