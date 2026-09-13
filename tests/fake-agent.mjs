import {createInterface} from 'node:readline';
import fs from 'node:fs';
const provider=process.argv[2];
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
let prompt='';

// `claude auth status` is a separate process call, not a stream: answer it and exit.
if(process.argv.includes('auth')&&process.argv.includes('status')){
  process.stdout.write(JSON.stringify({loggedIn:true,authMethod:'prueba',subscriptionType:'prueba'}));
  process.exit(0);
}

const MODELS={codex:[{model:'codex-fake',displayName:'Codex de prueba',isDefault:true,
  supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}]}],
  claude:[{value:'claude-fake',displayName:'Claude de prueba',supportedEffortLevels:['medium','high']},
    {value:'claude-fake-rapido',displayName:'Claude de prueba rápido',supportedEffortLevels:['low','medium']}]};

// Scripted answers for an orchestrated run: the plan, then each sub-task, then the review.
const scenario=process.env.FAKE_AGENT_SCENARIO||'base';
const PLAN='```json\n'+JSON.stringify({resumen:'Dos frentes en paralelo',subtareas:[
  {titulo:'Frente uno',proveedor:'claude',modelo:'claude-fake',esfuerzo:'medium',justificacion:'trabajo mecánico',
    rol:'Escribir uno.txt',instrucciones:'ARCHIVO:uno.txt',alcance:['uno.txt'],soloLectura:false,orden:1},
  {titulo:'Frente dos',proveedor:'claude',modelo:'claude-fake',esfuerzo:'medium',justificacion:'trabajo mecánico',
    rol:'Escribir dos.txt',instrucciones:'ARCHIVO:dos.txt',alcance:['dos.txt'],soloLectura:false,orden:2}]})+'\n```';
// Both sub-tasks deliberately write the same relative path from their own isolated worktree, so the
// supervisor sees a collision even though nothing on disk actually overlaps yet.
const PLAN_COLISION='```json\n'+JSON.stringify({resumen:'Dos frentes que chocan a propósito',subtareas:[
  {titulo:'Frente colisión uno',proveedor:'claude',modelo:'claude-fake',esfuerzo:'medium',justificacion:'trabajo mecánico',
    rol:'Escribir compartido.txt',instrucciones:'ARCHIVO:compartido.txt',alcance:['compartido.txt'],soloLectura:false,orden:1},
  {titulo:'Frente colisión dos',proveedor:'claude',modelo:'claude-fake',esfuerzo:'medium',justificacion:'trabajo mecánico',
    rol:'Escribir compartido.txt',instrucciones:'ARCHIVO:compartido.txt',alcance:['compartido.txt'],soloLectura:false,orden:2}]})+'\n```';
const SUPERVISION_DETENER='```json\n'+JSON.stringify({accion:'detener',subtarea:1,motivo:'Las dos sub-tareas tocan compartido.txt'})+'\n```';

function scripted(text){
  if(text.includes('AGENTES Y MODELOS DISPONIBLES'))return scenario==='colision'?PLAN_COLISION:PLAN;
  if(text.includes('"accion":"seguir"'))return scenario==='colision'?SUPERVISION_DETENER:'```json\n{"accion":"seguir"}\n```';
  if(text.includes('VEREDICTO'))return 'Sin duplicados ni contradicciones.\n\nVEREDICTO: INTEGRAR';
  const file=/ARCHIVO:([\w.-]+)/.exec(text);
  if(file){
    // Written up front, then a slow "thinking" pause: this leaves a real window where the file is
    // visible on disk before the sub-task reports back, which is what the live supervisor polls for.
    fs.writeFileSync(file[1],`escrito por la sub-tarea ${file[1]}\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Number(process.env.FAKE_AGENT_DELAY||600));
    return `Escribí ${file[1]}`;
  }
  return null;
}
function codexDone(text='Respuesta verificada: áéñ'){
  send({method:'item/agentMessage/delta',params:{itemId:'m1',delta:text.slice(0,8)}});
  send({method:'item/agentMessage/delta',params:{itemId:'m1',delta:text.slice(8)}});
  send({method:'item/completed',params:{item:{id:'m1',type:'agentMessage',text}}});
  send({method:'turn/completed',params:{turn:{id:'turn1',status:'completed'}}});
}
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(provider==='codex'){
   if(m.method==='initialize')send({id:m.id,result:{}});
   if(m.method==='account/read')send({id:m.id,result:{account:{planType:'prueba',type:'prueba'}}});
   if(m.method==='model/list')send({id:m.id,result:{data:MODELS.codex,nextCursor:null}});
   if(m.method==='account/rateLimits/read')send({id:m.id,result:{}});
   if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:m.params.threadId||'native-codex'}}});
   if(m.method==='turn/start'){
     prompt=m.params.input[0].text;send({id:m.id,result:{turn:{id:'turn1'}}});
     if(prompt==='ERROR')return send({method:'turn/completed',params:{turn:{status:'failed',error:{message:'Fallo controlado'}}}});
     if(prompt==='WAIT')return;
     if(prompt==='PERMISSION')return send({id:99,method:'item/commandExecution/requestApproval',params:{threadId:'native-codex',turnId:'turn1',command:'echo test',cwd:process.cwd()}});
     codexDone(scripted(prompt)||undefined);
   }
   if(m.id===99&&m.result)codexDone(m.result.decision==='accept'?'Permitido':'Rechazado');
 }else{
   if(m.type==='control_request'&&m.request.subtype==='initialize')send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:MODELS.claude,account:{subscriptionType:'prueba'}}}});
   if(m.type==='user'){
     prompt=m.message.content;
     send({type:'system',subtype:'init',session_id:'native-claude'});
     if(prompt==='ERROR')return send({type:'result',is_error:true,errors:['Fallo controlado']});
     if(prompt==='WAIT')return;
     if(prompt==='PERMISSION')return send({type:'control_request',request_id:'permission1',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'echo test'}}});
     const text=scripted(prompt)||'Respuesta verificada: áéñ';
     send({type:'stream_event',event:{delta:{type:'text_delta',text:'Respuesta '}}});
     send({type:'assistant',message:{content:[{type:'text',text}]}});
     send({type:'result',is_error:false,result:text,session_id:'native-claude'});
   }
   if(m.type==='control_response'&&m.response.request_id==='permission1')send({type:'result',is_error:false,result:m.response.response.behavior==='allow'?'Permitido':'Rechazado',session_id:'native-claude'});
 }
});
