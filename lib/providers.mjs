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

// Consumo de un turno en una forma común a los dos agentes. Claude informa en snake_case y separa la
// caché; Codex informa en camelCase con la caché incluida en la entrada. `total` es lo procesado.
export function normalizeUsage(provider,raw,costUsd) {
  if(!raw||typeof raw!=='object')return null;
  const n=value=>Number(value)||0;
  let input,cached,output,total;
  if(provider==='claude') {
    input=n(raw.input_tokens);cached=n(raw.cache_read_input_tokens)+n(raw.cache_creation_input_tokens);output=n(raw.output_tokens);
    total=input+cached+output;
  } else {
    input=n(raw.inputTokens??raw.input_tokens);cached=n(raw.cachedInputTokens??raw.cached_input_tokens);output=n(raw.outputTokens??raw.output_tokens);
    total=n(raw.totalTokens??raw.total_tokens)||input+output;
  }
  if(!total)return null;
  return {input,cached,output,total,costUsd:Number(costUsd)||0};
}

// La respuesta de cuota de Codex no está fijada por contrato: se buscan ventanas con `usedPercent`
// a poca profundidad y se ignora todo lo demás, para que un cambio de forma nunca rompa la app.
export function normalizeLimits(raw) {
  const windows=[];
  const visit=(node,depth)=>{
    if(!node||typeof node!=='object'||depth>4)return;
    const used=node.usedPercent??node.used_percent;
    if(typeof used==='number') {
      const minutes=node.windowDurationMins??node.windowMinutes??node.window_minutes;
      const resets=node.resetsAt??node.resets_at;
      let resetsAt=null;
      if(typeof resets==='number')resetsAt=new Date(resets<1e12?resets*1000:resets).toISOString();
      else if(typeof resets==='string'&&!Number.isNaN(Date.parse(resets)))resetsAt=new Date(resets).toISOString();
      windows.push({usedPercent:Math.max(0,Math.min(100,used)),minutes:Number.isFinite(minutes)?minutes:null,resetsAt});
      return;
    }
    for(const value of Object.values(node))visit(value,depth+1);
  };
  // Codex publica los mismos límites por dos caminos (rateLimits y rateLimitsByLimitId): se lee uno solo, y
  // si aun así una ventana se repite, se conserva una vez con el mayor uso.
  visit(raw&&typeof raw==='object'&&raw.rateLimits&&typeof raw.rateLimits==='object'?raw.rateLimits:raw,0);
  const unique=new Map();
  for(const window of windows){const key=String(window.minutes);const seen=unique.get(key);if(!seen||window.usedPercent>seen.usedPercent)unique.set(key,{...window,resetsAt:window.resetsAt||seen?.resetsAt||null});}
  const result=[...unique.values()].sort((a,b)=>(a.minutes??Infinity)-(b.minutes??Infinity));
  return result.length?{windows:result,readAt:new Date().toISOString()}:null;
}

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

const APP_VERSION=(()=>{try{return JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version||'0.0.0';}catch{return '0.0.0';}})();
async function codexConnection(cwd){
  const io=new Lines('codex',['app-server'],cwd);
  try{await io.request('initialize',{clientInfo:{name:'mixto',title:'Mixto',version:APP_VERSION}});io.send({method:'initialized',params:{}});return io;}
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
      let limits=null;try{limits=normalizeLimits(await io.request('account/rateLimits/read',{}));}catch{}
      return {connected:!!account.account,plan:account.account?.planType||account.account?.type||'',authType:account.account?.type,
        models:models.map(m=>({id:m.model,name:m.displayName,description:m.description,hidden:m.hidden,default:m.isDefault,efforts:m.supportedReasoningEfforts?.map(e=>e.reasoningEffort)||[],defaultEffort:m.defaultReasoningEffort})),limits,updatedAt:new Date().toISOString()};
    }
    io=new Lines('claude',claudeBase,cwd);
    const info=await io.request('initialize',{},true);
    const [command,...prefix]=resolveCommand(executables.claude);
    const {stdout}=await execFileAsync(command,[...prefix,'auth','status'],{windowsHide:true,timeout:15000,maxBuffer:1024*1024}).catch(error=>{if(error.stdout)return {stdout:error.stdout};throw error;});
    const auth=JSON.parse(stdout);
    return {connected:auth.loggedIn,plan:info.account?.subscriptionType||auth.subscriptionType||'',authType:auth.authMethod,
      models:(info.models||[]).map(m=>({id:m.value,name:m.displayName,resolved:m.resolvedModel,description:m.description,default:m.value==='default',efforts:m.supportedEffortLevels||[],defaultEffort:'medium'})),limits:null,updatedAt:new Date().toISOString()};
  }finally{await io?.close();}
}

// Solo la cuota, sin volver a listar modelos: se consulta al terminar cada tarea. Claude Code no la expone.
export async function readLimits(provider,cwd) {
  if(provider!=='codex')return null;
  const io=await codexConnection(cwd);
  try {return normalizeLimits(await io.request('account/rateLimits/read',{}));}
  finally {await io.close();}
}

// Adjuntos: las imágenes viajan como contenido del mensaje; el resto se menciona por su ruta para que el
// agente lo lea si le hace falta.
const IMAGE_TYPES=new Set(['image/png','image/jpeg','image/gif','image/webp']);
function attachmentNote(o){
  const others=(o.attachments||[]).filter(a=>!IMAGE_TYPES.has(a.mime));
  return others.length?`\n\nARCHIVOS ADJUNTOS POR EL USUARIO (léelos si hacen falta):\n${others.map(a=>`- ${a.name}: ${a.path}`).join('\n')}`:'';
}
function claudeContent(o){
  const images=(o.attachments||[]).filter(a=>IMAGE_TYPES.has(a.mime));
  const text=o.prompt+attachmentNote(o);
  if(!images.length)return text;
  return [{type:'text',text},...images.map(a=>({type:'image',source:{type:'base64',media_type:a.mime,data:fs.readFileSync(a.path).toString('base64')}}))];
}
function codexInput(o){
  const images=(o.attachments||[]).filter(a=>IMAGE_TYPES.has(a.mime));
  return [{type:'text',text:o.prompt+attachmentNote(o)},...images.map(a=>({type:'localImage',path:a.path}))];
}

// Los comandos permitidos del proyecto se consultan en el momento de la petición, así «permitir siempre»
// vale también para el resto de la misma tarea.
function allowedCommand(o,command){
  if(!command||typeof o.allowCommand!=='function'||o.allowCommand(command)!==true)return false;
  o.onEvent('Comando permitido en el proyecto: '+String(command).replace(/\s+/g,' ').trim().slice(0,120));
  return true;
}

// Sesiones vivas: el proceso de cada agente se mantiene abierto entre turnos para no pagar su arranque en
// cada mensaje. Se reutiliza solo para seguir la misma sesión con las mismas opciones; se cierra tras diez
// minutos sin uso, si un turno se detiene, si el proceso falla o al apagar Mixto. MIXTO_NO_POOL=1 lo desactiva.
const POOL_IDLE_MS=10*60*1000,POOL_MAX=4;
const pool=new Map();
const poolEnabled=()=>process.env.MIXTO_NO_POOL!=='1';
function poolTake(key){
  const entry=pool.get(key);
  if(!entry||entry.busy||entry.io.closed)return null;
  clearTimeout(entry.timer);entry.busy=true;return entry;
}
function poolGive(key,entry){
  const other=pool.get(key);
  if(!poolEnabled()||entry.io.closed||(other&&other!==entry&&other.busy)){void entry.io.close();return;}
  if(other&&other!==entry)poolDrop(key,other);
  entry.busy=false;entry.lastUsed=Date.now();
  entry.timer=setTimeout(()=>poolDrop(key,entry),POOL_IDLE_MS);entry.timer.unref?.();
  pool.set(key,entry);
  entry.io.once('closed',()=>{if(pool.get(key)===entry){clearTimeout(entry.timer);pool.delete(key);}});
  while(pool.size>POOL_MAX){
    let oldest=null;
    for(const [k,e] of pool)if(!e.busy&&(!oldest||e.lastUsed<oldest[1].lastUsed))oldest=[k,e];
    if(!oldest)break;poolDrop(oldest[0],oldest[1]);
  }
}
function poolDrop(key,entry){if(pool.get(key)===entry)pool.delete(key);clearTimeout(entry.timer);void entry.io.close();}
export function closeAllSessions(){for(const entry of pool.values()){clearTimeout(entry.timer);void entry.io.close();}pool.clear();}
export const liveSessions=()=>pool.size;

export async function runProvider(provider,options){
  return provider==='codex'?runCodex(options):runClaude(options);
}

async function runCodex(o){
  const key='codex:'+o.cwd;
  let entry=poolTake(key),io;
  if(entry)io=entry.io;
  else{io=await codexConnection(o.cwd);entry={io,busy:true,threads:new Set(),lastUsed:Date.now(),timer:null};}
  let threadId,turnId,finish,fail,settled=false,ok=false,texts=new Map(),pendingDelta=new Map(),usage=null;
  const completed=new Promise((resolve,reject)=>{finish=resolve;fail=reject;});
  completed.catch(()=>{});
  const abort=()=>{if(threadId&&turnId)io.send({id:++io.next,method:'turn/interrupt',params:{threadId,turnId}});fail(new Error('Tarea detenida.'));};
  const onClosed=e=>{if(!settled)fail(e);};
  io.on('closed',onClosed);
  const onMessage=m=>{
    const p=m.params||{};
    if(m.id!==undefined&&m.method){
      void (async()=>{
        try{
          if(m.method==='item/commandExecution/requestApproval'||m.method==='item/fileChange/requestApproval'){
            const command=m.method.includes('fileChange')?undefined:(Array.isArray(p.command)?p.command.join(' '):typeof p.command==='string'?p.command:undefined);
            // Un comando permitido en el proyecto se acepta sin preguntar; una consulta nunca escala al usuario.
            const answer=allowedCommand(o,command)?{allow:true}:o.readOnly?{allow:false}:await o.approve({kind:'permission',title:m.method.includes('fileChange')?'Modificar archivos':'Ejecutar una acción',details:p,command});
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
    // `last` es el turno actual; `total` acumula el hilo entero, que puede venir de sesiones anteriores.
    if(m.method==='thread/tokenUsage/updated')usage=normalizeUsage('codex',p.tokenUsage?.last||p.tokenUsage?.total||p.tokenUsage)||usage;
    if(m.method==='turn/completed'){
      settled=true;
      usage=normalizeUsage('codex',p.turn?.usage||p.usage)||usage;
      p.turn.status==='completed'?finish({text:[...texts.values()].join('\n\n'),sessionId:threadId,usage,permissionDenials:[]}):fail(new Error(p.turn.error?.message||`Turno ${p.turn.status}`));
    }
  };
  io.on('message',onMessage);
  o.signal.addEventListener('abort',abort,{once:true});
  try{
    if(o.signal.aborted)throw new Error('Tarea detenida.');
    const params={cwd:o.cwd,model:o.model,sandbox:o.readOnly?'read-only':'workspace-write',approvalPolicy:o.readOnly?'never':'on-request',approvalsReviewer:'user'};
    if(o.sessionId&&entry.threads.has(o.sessionId))threadId=o.sessionId;
    else{
      const thread=await io.request(o.sessionId?'thread/resume':'thread/start',{...params,...(o.sessionId?{threadId:o.sessionId}:{})});
      threadId=thread.thread.id;
    }
    entry.threads.add(threadId);o.onSession(threadId);
    const turn=await io.request('turn/start',{threadId,input:codexInput(o),...(o.effort?{effort:o.effort}:{})});
    turnId=turn.turn.id;
    const result=await completed;ok=true;return result;
  }finally{
    settled=true;o.signal.removeEventListener('abort',abort);io.off('message',onMessage);io.off('closed',onClosed);
    if(ok&&!io.closed)poolGive(key,entry);else poolDrop(key,entry);
  }
}

async function runClaude(o){
  const args=[...claudeBase,'--model',o.model,'--permission-mode',o.readOnly?'manual':'acceptEdits'];
  if(o.effort)args.push('--effort',o.effort);
  if(o.sessionId)args.push('--resume',o.sessionId);
  // Restrict the actual tool surface for review, rather than relying on a prompt. A reviewer may get
  // Bash on top, still behind the user's approval except for the read-only git commands listed.
  if(o.readOnly)args.push('--tools',['Read','Glob','Grep',...(o.extraTools||[])].join(','),'--safe-mode');
  if(o.allowedTools?.length)args.push('--allowedTools',o.allowedTools.join(','));
  const key='claude:'+JSON.stringify([o.cwd,o.model,o.effort||'',!!o.readOnly,(o.extraTools||[]).join(','),(o.allowedTools||[]).join(',')]);
  let entry=poolTake(key);
  if(entry&&(!o.sessionId||entry.sessionId!==o.sessionId)){poolDrop(key,entry);entry=null;}
  let io;
  if(entry)io=entry.io;
  else{io=new Lines('claude',args,o.cwd);entry={io,busy:true,sessionId:o.sessionId||null,fresh:true,lastUsed:Date.now(),timer:null};}
  let finish,fail,settled=false,ok=false,fullText='',streamText='',sessionId=o.sessionId;
  const completed=new Promise((resolve,reject)=>{finish=resolve;fail=reject;});completed.catch(()=>{});
  const abort=()=>{io.send({type:'control_request',request_id:randomUUID(),request:{subtype:'interrupt'}});fail(new Error('Tarea detenida.'));};
  const onClosed=e=>{if(!settled)fail(e);};
  io.on('closed',onClosed);
  const onMessage=m=>{
    if(m.session_id){sessionId=m.session_id;o.onSession(sessionId);}
    if(m.type==='control_request'){
      void(async()=>{
        const r=m.request;
        try{
          if(r.subtype==='can_use_tool'){
            const isQuestion=r.tool_name==='AskUserQuestion';
            const command=r.tool_name==='Bash'&&typeof r.input?.command==='string'?r.input.command:undefined;
            // En consulta no hay herramientas de escritura; un comando sí se le pregunta al usuario, salvo los permitidos.
            const answer=(!isQuestion&&allowedCommand(o,command))?{allow:true}:(!isQuestion&&o.readOnly&&!command)?{allow:false}:await o.approve({kind:isQuestion?'claude-question':'permission',title:isQuestion?'Claude necesita una respuesta':`Claude · ${r.tool_name}`,details:r.input,command});
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
      else{const text=(m.result||fullText+streamText).trim();o.onText(text);finish({text,sessionId,usage:normalizeUsage('claude',m.usage,m.total_cost_usd),permissionDenials:m.permission_denials||[]});}
    }
  };
  io.on('message',onMessage);
  o.signal.addEventListener('abort',abort,{once:true});
  try{
    if(o.signal.aborted)throw new Error('Tarea detenida.');
    if(entry.fresh){await io.request('initialize',{},true);entry.fresh=false;}
    io.send({type:'user',message:{role:'user',content:claudeContent(o)},parent_tool_use_id:null,session_id:sessionId||''});
    const result=await completed;ok=true;entry.sessionId=result.sessionId||sessionId||null;return result;
  }finally{
    settled=true;o.signal.removeEventListener('abort',abort);io.off('message',onMessage);io.off('closed',onClosed);
    if(ok&&!io.closed&&entry.sessionId)poolGive(key,entry);else poolDrop(key,entry);
  }
}
