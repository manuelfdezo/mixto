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
// Una cuota con la forma del app-server de Codex, para que la normalización se ejerza de punta a punta.
const LIMITS={rateLimits:{primary:{usedPercent:34,windowDurationMins:300,resetsAt:1800000000},secondary:{usedPercent:12,windowDurationMins:10080,resetsAt:1800500000}}};
const CLAUDE_USAGE={input_tokens:100,cache_creation_input_tokens:0,cache_read_input_tokens:30,output_tokens:20};

// Scripted answers for an orchestrated run: the plan, then each sub-task, then the review.
const scenario=process.env.FAKE_AGENT_SCENARIO||'base';
const fence=object=>'```json\n'+JSON.stringify(object)+'\n```';
const writer=(titulo,file,orden)=>({titulo,proveedor:'claude',modelo:'claude-fake',esfuerzo:'medium',justificacion:'trabajo mecánico',
  rol:`Escribir ${file}`,instrucciones:`ARCHIVO:${file}`,alcance:[file],soloLectura:false,orden});
const PLAN=fence({resumen:'Dos frentes en paralelo',contexto:'El proyecto es una carpeta de prueba con base.txt.',
  subtareas:[writer('Frente uno','uno.txt',1),writer('Frente dos','dos.txt',2)]});
// Both sub-tasks deliberately write the same relative path from their own isolated worktree, so the
// supervisor sees a collision even though nothing on disk actually overlaps yet.
const PLAN_COLISION=fence({resumen:'Dos frentes que chocan a propósito',
  subtareas:[writer('Frente colisión uno','compartido.txt',1),writer('Frente colisión dos','compartido.txt',2)]});
const PLAN_UNICA=fence({resumen:'Un solo escritor',contexto:'Trabaja en la carpeta real.',subtareas:[writer('Frente único','solo.txt',1)]});
const PLAN_UNICA_CODEX=fence({resumen:'Un solo escritor, en Codex',subtareas:[{...writer('Frente único','solo.txt',1),proveedor:'codex',modelo:'codex-fake'}]});
const PLAN_LECTURA=fence({resumen:'Una sola consulta',subtareas:[{titulo:'Consulta',proveedor:'claude',modelo:'claude-fake',esfuerzo:'medium',
  justificacion:'solo leer',rol:'Investigar',instrucciones:'CONSULTA: describe base.txt',alcance:[],soloLectura:true,orden:1}]});
// A direct answer with a code fence inside the JSON string: the parser must survive the inner ```.
const RESPUESTA='Aquí tienes:\n```json\n{"respuesta":"Es un proyecto de prueba con `base.txt`. Ejemplo:\\n```js\\nconsole.log(1)\\n```\\nNada más."}\n```';
const SUPERVISION_DETENER=fence({accion:'detener',subtarea:1,motivo:'Las dos sub-tareas tocan compartido.txt'});

function scripted(text){
  // Una corrección se detecta antes que nada: su prompt contiene la revisión, que a su vez contiene VEREDICTO.
  if(text.includes('CORRECCIÓN SOLICITADA')){
    const file=/ARCHIVO:([\w.-]+)/.exec(text);
    if(file)fs.writeFileSync(file[1],`corregido por la sub-tarea ${file[1]}\n`);
    return `Corregido ${file?file[1]:''}`;
  }
  if(text.includes('AGENTES Y MODELOS DISPONIBLES')){
    if(scenario==='colision')return PLAN_COLISION;
    if(scenario==='unica'||scenario==='auto')return PLAN_UNICA;
    if(scenario==='unica-codex')return PLAN_UNICA_CODEX;
    if(scenario==='lectura')return PLAN_LECTURA;
    if(scenario==='directa')return RESPUESTA;
    return PLAN;
  }
  if(text.includes('"accion":"seguir"'))return scenario==='colision'?SUPERVISION_DETENER:'```json\n{"accion":"seguir"}\n```';
  // The review is recognised by its own heading: «VEREDICTO» also travels inside memory records.
  if(text.includes('TRABAJO DE CADA SUB-TAREA')){
    // In the fix scenario the first review rejects; only a corrected patch is accepted.
    if(scenario==='corregir'&&!text.includes('corregido'))return 'Falta la corrección en uno.txt.\n\nVEREDICTO: NO INTEGRAR';
    return 'Sin duplicados ni contradicciones.\n\nVEREDICTO: INTEGRAR';
  }
  if(text.includes('CONSULTA:'))return 'base.txt contiene la palabra base.';
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
  send({method:'thread/tokenUsage/updated',params:{threadId:'native-codex',turnId:'turn1',tokenUsage:{last:{inputTokens:100,cachedInputTokens:30,outputTokens:20,reasoningOutputTokens:5,totalTokens:120},total:{inputTokens:900,cachedInputTokens:300,outputTokens:200,reasoningOutputTokens:50,totalTokens:1100}}}});
  send({method:'turn/completed',params:{turn:{id:'turn1',status:'completed'}}});
}
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(provider==='codex'){
   if(m.method==='initialize')send({id:m.id,result:{}});
   if(m.method==='account/read')send({id:m.id,result:{account:{planType:'prueba',type:'prueba'}}});
   if(m.method==='model/list')send({id:m.id,result:{data:MODELS.codex,nextCursor:null}});
   if(m.method==='account/rateLimits/read')send({id:m.id,result:LIMITS});
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
     send({type:'result',is_error:false,result:text,session_id:'native-claude',usage:CLAUDE_USAGE,total_cost_usd:0.0123});
   }
   if(m.type==='control_response'&&m.response.request_id==='permission1')send({type:'result',is_error:false,result:m.response.response.behavior==='allow'?'Permitido':'Rechazado',session_id:'native-claude'});
 }
});
