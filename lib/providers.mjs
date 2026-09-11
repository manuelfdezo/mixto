import {spawn,execFile} from 'node:child_process';
import {createInterface} from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
const execFileAsync=promisify(execFile);
// A path, or a JSON array when the command needs its own arguments (used to point at a stand-in agent).
const executable=value=>{try{const parsed=JSON.parse(value);return Array.isArray(parsed)?parsed:value;}catch{return value;}};
export const executables={codex:executable(process.env.MIXTO_CODEX_PATH||'codex'),claude:executable(process.env.MIXTO_CLAUDE_PATH||'claude')};

const WINDOWS_EXTENSIONS=['.exe','.com','.cmd','.bat'];

function findOnPath(command) {
  if(path.extname(command)&&fs.existsSync(command))return command;
  const directories=command.includes(path.sep)||command.includes('/')
    ? [path.dirname(command)]
    : (process.env.PATH||'').split(path.delimiter).filter(Boolean).map(entry=>entry.replace(/"/g,''));
  const name=path.basename(command);
  for(const directory of directories) {
    // Only a real program or an interpreter script counts: the extensionless shim next to them is a
    // shell script that Windows cannot execute.
    for(const extension of WINDOWS_EXTENSIONS) {
      const candidate=path.join(directory,name+extension);
      if(fs.existsSync(candidate))return candidate;
    }
  }
  return command;
}

// Windows can only spawn real executables. A CLI installed through npm lands as a .cmd shim, so it has
// to be handed to the command interpreter instead — otherwise spawn fails with ENOENT.
export function resolveCommand(command) {
  const parts=Array.isArray(command)?[...command]:[command];
  if(process.platform!=='win32')return parts;
  const resolved=findOnPath(parts[0]);
  if(/\.(cmd|bat)$/i.test(resolved))return [process.env.ComSpec||'cmd.exe','/d','/s','/c',resolved,...parts.slice(1)];
  return [resolved,...parts.slice(1)];
}

class Lines extends EventEmitter {
  constructor(provider,args,cwd) {
    super();this.stderr='';this.pending=new Map();this.next=0;this.closed=false;
    const [command,...prefix]=resolveCommand(executables[provider]);
    this.child=spawn(command,[...prefix,...args],{cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child.stdin.on('error',()=>{});
    this.child.stderr.on('data',d=>{this.stderr=(this.stderr+d.toString()).slice(-6000);});
    createInterface({input:this.child.stdout}).on('line',line=>{
      let m;try{m=JSON.parse(line);}catch{return;}
      const key=m.type==='control_response'?m.response.request_id:m.id;
      const pending=this.pending.get(key);
      if(pending&&!m.method){
        this.pending.delete(key);clearTimeout(pending.timer);
        const error=m.error||(m.response?.subtype==='error'?{message:m.response.error}:null);
        error?pending.reject(new Error(error.message||String(error))):pending.resolve(m.type==='control_response'?m.response.response:m.result);
      } else this.emit('message',m);
    });
    this.child.on('error',e=>this.fail(e));
    this.child.on('exit',(code)=>this.fail(new Error(this.stderr||`El agente se cerró (${code}).`)));
    this.exited=new Promise(resolve=>{this.child.once('exit',resolve);this.child.once('error',resolve);});
  }
  fail(error){
    if(this.closed)return;this.closed=true;this.lastError=error;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.emit('closed',error);
  }
  send(m){if(!this.closed)this.child.stdin.write(JSON.stringify(m)+'\n');}
  request(method,params,claude=false){
    if(this.closed)return Promise.reject(this.lastError||new Error('Conexión cerrada.'));
    const requestId=claude?randomUUID():++this.next;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(requestId);reject(new Error('El agente no respondió a tiempo.'));},45000);
      this.pending.set(requestId,{resolve,reject,timer});
      this.send(claude?{type:'control_request',request_id:requestId,request:{subtype:method,...params}}:{id:requestId,method,params});
    });
  }
  close(){
    if(this.stopping)return this.stopping;
    if(this.closed)return this.exited;
    this.stopping=this.exited;
    this.child.stdin.end();
    if(process.platform==='win32'&&this.child.pid){
      // Terminate only this owned process tree, including any running tool child.
      execFile('taskkill.exe',['/PID',String(this.child.pid),'/T','/F'],{windowsHide:true},()=>{});
    }else this.child.kill();
    this.fail(new Error('Conexión finalizada.'));
    return this.stopping;
  }
}

async function codexConnection(cwd){
  const io=new Lines('codex',['app-server'],cwd);
  try{await io.request('initialize',{clientInfo:{name:'mixto',title:'Mixto',version:'1.0.0'}});io.send({method:'initialized',params:{}});return io;}
  catch(e){await io.close();throw e;}
}
const claudeBase=['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages','--permission-prompt-tool','stdio'];

export async function discover(provider,cwd){
  let io;
  try{
    if(provider==='codex'){
      io=await codexConnection(cwd);
      const account=await io.request('account/read',{});
      let cursor,models=[];
      do{const page=await io.request('model/list',{includeHidden:true,limit:100,...(cursor?{cursor}:{})});models.push(...page.data);cursor=page.nextCursor;}while(cursor);
      let limits=null;try{limits=await io.request('account/rateLimits/read',{});}catch{}
      return {connected:!!account.account,plan:account.account?.planType||account.account?.type||'',authType:account.account?.type,
        models:models.map(m=>({id:m.model,name:m.displayName,description:m.description,hidden:m.hidden,default:m.isDefault,efforts:m.supportedReasoningEfforts?.map(e=>e.reasoningEffort)||[],defaultEffort:m.defaultReasoningEffort})),limits,updatedAt:new Date().toISOString()};
    }
    io=new Lines('claude',claudeBase,cwd);
    const info=await io.request('initialize',{},true);
    const [command,...prefix]=resolveCommand(executables.claude);
    const {stdout}=await execFileAsync(command,[...prefix,'auth','status'],{windowsHide:true,timeout:15000,maxBuffer:1024*1024}).catch(error=>{if(error.stdout)return {stdout:error.stdout};throw error;});
    const auth=JSON.parse(stdout);
    return {connected:auth.loggedIn,plan:info.account?.subscriptionType||auth.subscriptionType||'',authType:auth.authMethod,
      models:(info.models||[]).map(m=>({id:m.value,name:m.displayName,resolved:m.resolvedModel,description:m.description,default:m.value==='default',efforts:m.supportedEffortLevels||[],defaultEffort:'medium'})),updatedAt:new Date().toISOString()};
  }finally{await io?.close();}
}

export async function runProvider(provider,options){
  return provider==='codex'?runCodex(options):runClaude(options);
}

async function runCodex(o){
  const io=await codexConnection(o.cwd);
  let threadId,turnId,finish,fail,settled=false,texts=new Map(),pendingDelta=new Map();
  const completed=new Promise((resolve,reject)=>{finish=resolve;fail=reject;});
  completed.catch(()=>{});
  const abort=()=>{if(threadId&&turnId)io.send({id:++io.next,method:'turn/interrupt',params:{threadId,turnId}});fail(new Error('Tarea detenida.'));io.close();};
  io.on('closed',e=>{if(!settled)fail(e);});
  io.on('message',m=>{
    const p=m.params||{};
    if(m.id!==undefined&&m.method){
      void (async()=>{
        try{
          if(m.method==='item/commandExecution/requestApproval'||m.method==='item/fileChange/requestApproval'){
            const answer=o.readOnly?{allow:false}:await o.approve({kind:'permission',title:m.method.includes('fileChange')?'Modificar archivos':'Ejecutar una acción',details:p});
            io.send({id:m.id,result:{decision:answer.allow?'accept':'decline'}});
          }else if(m.method==='item/tool/requestUserInput'){
            const answer=await o.approve({kind:'question',title:'Codex necesita una respuesta',details:p});
            io.send({id:m.id,result:{answers:answer.answers||{}}});
          }else if(m.method==='item/permissions/requestApproval'){
            const answer=o.readOnly?{allow:false}:await o.approve({kind:'permission',title:'Ampliar permisos',details:p});
            io.send({id:m.id,result:{permissions:answer.allow?p.permissions:{},scope:'turn'}});
          }else if(m.method==='mcpServer/elicitation/request'){
            // Unknown form schemas are not guessed or automatically accepted.
            io.send({id:m.id,result:{action:'decline',content:null}});o.onEvent('La herramienta pidió una confirmación externa no compatible; se ha rechazado.');
          }else io.send({id:m.id,error:{code:-32601,message:'Mixto no admite esta solicitud interactiva.'}});
        }catch(e){io.send({id:m.id,error:{code:-32000,message:e.message}});}
      })();return;
    }
    if(m.method==='item/agentMessage/delta'){
      pendingDelta.set(p.itemId,(pendingDelta.get(p.itemId)||'')+p.delta);
      texts.set(p.itemId,pendingDelta.get(p.itemId));o.onText([...texts.values()].join('\n\n'));
    }
    if(m.method==='item/started'){
      if(p.item?.type==='commandExecution')o.onEvent('Ejecutando: '+p.item.command);
      else if(p.item?.type==='fileChange')o.onEvent('Modificando archivos del proyecto');
      else if(p.item?.type==='mcpToolCall')o.onEvent('Herramienta: '+p.item.tool);
    }
    if(m.method==='item/completed'&&p.item?.type==='agentMessage'){
      texts.set(p.item.id,p.item.text);o.onText([...texts.values()].join('\n\n'));
    }
    if(m.method==='error')o.onEvent(p.error?.message||'El agente ha comunicado un error.');
    if(m.method==='turn/completed'){
      settled=true;
      p.turn.status==='completed'?finish({text:[...texts.values()].join('\n\n'),sessionId:threadId}):fail(new Error(p.turn.error?.message||`Turno ${p.turn.status}`));
    }
  });
  o.signal.addEventListener('abort',abort,{once:true});
  try{
    if(o.signal.aborted)throw new Error('Tarea detenida.');
    const params={cwd:o.cwd,model:o.model,sandbox:o.readOnly?'read-only':'workspace-write',approvalPolicy:o.readOnly?'never':'on-request',approvalsReviewer:'user'};
    const thread=await io.request(o.sessionId?'thread/resume':'thread/start',{...params,...(o.sessionId?{threadId:o.sessionId}:{})});
    threadId=thread.thread.id;o.onSession(threadId);
    const turn=await io.request('turn/start',{threadId,input:[{type:'text',text:o.prompt}],...(o.effort?{effort:o.effort}:{})});
    turnId=turn.turn.id;
    return await completed;
  }finally{settled=true;o.signal.removeEventListener('abort',abort);await io.close();}
}

async function runClaude(o){
  const args=[...claudeBase,'--model',o.model,'--permission-mode',o.readOnly?'manual':'acceptEdits'];
  if(o.effort)args.push('--effort',o.effort);
  if(o.sessionId)args.push('--resume',o.sessionId);
  // Restrict the actual tool surface for review, rather than relying on a prompt.
  if(o.readOnly)args.push('--tools','Read,Glob,Grep','--safe-mode');
  const io=new Lines('claude',args,o.cwd);
  let finish,fail,settled=false,fullText='',streamText='',sessionId=o.sessionId;
  const completed=new Promise((resolve,reject)=>{finish=resolve;fail=reject;});completed.catch(()=>{});
  const abort=()=>{io.send({type:'control_request',request_id:randomUUID(),request:{subtype:'interrupt'}});fail(new Error('Tarea detenida.'));io.close();};
  io.on('closed',e=>{if(!settled)fail(e);});
  io.on('message',m=>{
    if(m.session_id){sessionId=m.session_id;o.onSession(sessionId);}
    if(m.type==='control_request'){
      void(async()=>{
        const r=m.request;
        try{
          if(r.subtype==='can_use_tool'){
            const isQuestion=r.tool_name==='AskUserQuestion';
            const answer=(!isQuestion&&o.readOnly)?{allow:false}:await o.approve({kind:isQuestion?'claude-question':'permission',title:isQuestion?'Claude necesita una respuesta':`Claude · ${r.tool_name}`,details:r.input});
            io.send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:answer.allow?{behavior:'allow',updatedInput:isQuestion?{...r.input,answers:answer.answers||{}}:r.input}:{behavior:'deny',message:'El usuario no ha autorizado esta acción.'}}});
          }else io.send({type:'control_response',response:{subtype:'error',request_id:m.request_id,error:'Solicitud no compatible con Mixto.'}});
        }catch(e){io.send({type:'control_response',response:{subtype:'error',request_id:m.request_id,error:e.message}});}
      })();return;
    }
    if(m.type==='stream_event'&&m.event?.delta?.type==='text_delta'){
      streamText+=m.event.delta.text;o.onText(fullText+streamText);
    }
    if(m.type==='assistant'){
      const parts=m.message?.content||[];
      const text=parts.filter(p=>p.type==='text').map(p=>p.text).join('\n');
      if(text){fullText+=text+'\n\n';streamText='';o.onText(fullText.trim());}
      for(const p of parts)if(p.type==='tool_use')o.onEvent(`Herramienta: ${p.name}`);
    }
    if(m.type==='result'){
      settled=true;
      if(m.is_error)fail(new Error((m.errors||[]).join('\n')||m.result||'Claude no ha podido completar la tarea.'));
      else{const text=(m.result||fullText+streamText).trim();o.onText(text);finish({text,sessionId,usage:m.usage,costEstimate:m.total_cost_usd,permissionDenials:m.permission_denials||[]});}
    }
  });
  o.signal.addEventListener('abort',abort,{once:true});
  try{
    if(o.signal.aborted)throw new Error('Tarea detenida.');
    await io.request('initialize',{},true);
    io.send({type:'user',message:{role:'user',content:o.prompt},parent_tool_use_id:null,session_id:sessionId||''});
    return await completed;
  }finally{settled=true;o.signal.removeEventListener('abort',abort);await io.close();}
}
