import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPlanPrompt,parsePlan,parseManualPlan,assignWaves,buildReviewPrompt,readVerdict,PlanError,buildSupervisionPrompt,parseDecision,buildWorkPrompt,buildFixPrompt,buildDirectPrompt,buildSelfPrompt,parseJsonBlock} from '../lib/orchestrator.mjs';

const connections={
  codex:{connected:true,models:[{id:'gpt-5-codex',name:'Codex',efforts:['low','medium','high'],default:true}]},
  claude:{connected:true,models:[
    {id:'opus',name:'Opus',efforts:['medium','high'],default:true},
    {id:'sonnet',name:'Sonnet',efforts:['low','medium','high']}]}
};
const plan=subtareas=>'```json\n'+JSON.stringify({resumen:'Dos frentes',subtareas})+'\n```';
const subtask=extra=>({titulo:'Tests',proveedor:'claude',modelo:'sonnet',esfuerzo:'medium',
  justificacion:'Trabajo mecánico',rol:'Probar',instrucciones:'Escribe los tests',alcance:['tests/'],soloLectura:false,orden:1,...extra});

test('parsePlan acepta un plan válido y normaliza sus campos',()=>{
  const result=parsePlan(plan([subtask(),subtask({titulo:'Docs',proveedor:'codex',modelo:'gpt-5-codex',esfuerzo:'high',orden:2})]),{connections});
  assert.equal(result.summary,'Dos frentes');
  assert.equal(result.subtasks.length,2);
  assert.deepEqual(result.warnings,[]);
  assert.equal(result.subtasks[0].provider,'claude');
  assert.equal(result.subtasks[0].model,'sonnet');
  assert.equal(result.subtasks[0].effort,'medium');
  assert.equal(result.subtasks[0].readOnly,false);
  assert.deepEqual(result.subtasks[0].scope,['tests/']);
  assert.equal(result.subtasks[1].order,2);
});

test('parsePlan encuentra el JSON aunque venga envuelto en prosa del agente',()=>{
  const text=`Analicé la carpeta y propongo esto:\n\n${plan([subtask()])}\n\nAvísame si querés ajustarlo.`;
  assert.equal(parsePlan(text,{connections}).subtasks.length,1);
});

test('parsePlan rechaza texto sin JSON o con JSON inválido, para que el llamador reintente',()=>{
  assert.throws(()=>parsePlan('No puedo planificar esto todavía.',{connections}),PlanError);
  assert.throws(()=>parsePlan('```json\n{"resumen":"roto",\n```',{connections}),PlanError);
  assert.throws(()=>parsePlan(plan([]),{connections}),PlanError);
});

test('parsePlan nunca relaja el techo de permisos del run',()=>{
  const escalate=parsePlan(plan([subtask({soloLectura:false})]),{connections,runReadOnly:true});
  assert.equal(escalate.subtasks[0].readOnly,true);
  const harden=parsePlan(plan([subtask({soloLectura:true})]),{connections,runReadOnly:false});
  assert.equal(harden.subtasks[0].readOnly,true);
  const missing=parsePlan(plan([subtask({soloLectura:undefined})]),{connections,runReadOnly:false});
  assert.equal(missing.subtasks[0].readOnly,false);
});

test('parsePlan coacciona modelos y esfuerzos fuera del catálogo en vez de fallar',()=>{
  const result=parsePlan(plan([subtask({modelo:'modelo-inventado',esfuerzo:'ultra'})]),{connections});
  assert.equal(result.subtasks[0].model,'opus');
  assert.equal(result.subtasks[0].effort,null);
  assert.equal(result.warnings.length,2);
  assert.match(result.warnings.join(' '),/modelo-inventado/);
});

test('parsePlan rechaza proveedores inexistentes o sin sesión iniciada',()=>{
  assert.throws(()=>parsePlan(plan([subtask({proveedor:'gemini'})]),{connections}),PlanError);
  const offline={...connections,codex:{...connections.codex,connected:false}};
  assert.throws(()=>parsePlan(plan([subtask({proveedor:'codex'})]),{connections:offline}),PlanError);
});

test('parsePlan recorta el plan al tope de sub-tareas y avisa',()=>{
  const many=Array.from({length:5},(_,i)=>subtask({orden:i+1}));
  const result=parsePlan(plan(many),{connections,maxSubtasks:3});
  assert.equal(result.subtasks.length,3);
  assert.match(result.warnings.join(' '),/3/);
});

test('parsePlan rechaza instrucciones vacías o desmedidas',()=>{
  assert.throws(()=>parsePlan(plan([subtask({instrucciones:'   '})]),{connections}),PlanError);
  assert.throws(()=>parsePlan(plan([subtask({instrucciones:'x'.repeat(12001)})]),{connections}),PlanError);
  assert.equal(parsePlan(plan([subtask({instrucciones:'x'.repeat(9000)})]),{connections}).subtasks[0].instructions.length,9000);
});

test('assignWaves paraleliza todo cuando hay aislamiento, respetando el tope',()=>{
  const subtasks=[1,2,3,4].map(n=>({id:'s'+n,order:n,readOnly:false}));
  assert.deepEqual(assignWaves(subtasks,{isolated:true,maxParallel:3}),[['s1','s2','s3'],['s4']]);
});

test('assignWaves serializa las escrituras cuando no hay aislamiento y agrupa las lecturas',()=>{
  const subtasks=[
    {id:'lee1',order:1,readOnly:true},
    {id:'escribe1',order:2,readOnly:false},
    {id:'lee2',order:3,readOnly:true},
    {id:'escribe2',order:4,readOnly:false}
  ];
  assert.deepEqual(assignWaves(subtasks,{isolated:false,maxParallel:3}),[['lee1','lee2'],['escribe1'],['escribe2']]);
});

test('buildReviewPrompt entrega evidencia calculada, no el relato de cada agente',()=>{
  const subtasks=[
    {id:'a',index:0,title:'Tests',role:'Probar',provider:'claude',model:'sonnet',status:'completed',
      text:'Añadí tres tests',patch:{files:2,insertions:40,deletions:1},readOnly:false},
    {id:'b',index:1,title:'Docs',role:'Documentar',provider:'codex',model:'gpt-5-codex',status:'error',
      error:'se quedó sin contexto',text:'',patch:null,readOnly:false}
  ];
  const prompt=buildReviewPrompt({request:'Añade tests y documenta',subtasks,overlaps:['lib/store.mjs'],
    failures:[{file:'0.patch',reason:'no aplica'}],patchText:{a:'diff --git a/x b/x'}});
  assert.match(prompt,/Sub-tarea 1: Tests/);
  assert.match(prompt,/se quedó sin contexto/);
  assert.match(prompt,/lib\/store\.mjs/);
  assert.match(prompt,/no aplica/);
  assert.match(prompt,/diff --git/);
  assert.match(prompt,/VEREDICTO: INTEGRAR/);
  assert.match(prompt,/solo lectura|no modifiques/i);
});

test('readVerdict se queda con el último veredicto y distingue NO INTEGRAR',()=>{
  assert.deepEqual(readVerdict('todo bien\n\nVEREDICTO: INTEGRAR'),{integrate:true,explicit:true});
  assert.deepEqual(readVerdict('VEREDICTO: NO INTEGRAR'),{integrate:false,explicit:true});
  // El instructivo del prompt menciona ambos; vale el último, que es el del revisor.
  assert.deepEqual(readVerdict('Escribe VEREDICTO: INTEGRAR o no.\n\nVEREDICTO: NO INTEGRAR'),{integrate:false,explicit:true});
  assert.deepEqual(readVerdict('me quedé sin responder'),{integrate:false,explicit:false});
});

test('parseDecision acepta un "seguir" válido',()=>{
  assert.deepEqual(parseDecision('```json\n{"accion":"seguir"}\n```'),{action:'seguir'});
});

test('parseDecision acepta un "detener" válido con número y motivo',()=>{
  const decision=parseDecision('Reviso el aviso.\n\n```json\n{"accion":"detener","subtarea":2,"motivo":"Pisa el mismo archivo"}\n```');
  assert.deepEqual(decision,{action:'detener',subtask:2,reason:'Pisa el mismo archivo'});
});

test('parseDecision recorta el motivo a 300 caracteres',()=>{
  const decision=parseDecision(`\`\`\`json\n{"accion":"detener","subtarea":1,"motivo":"${'x'.repeat(400)}"}\n\`\`\``);
  assert.equal(decision.reason.length,300);
});

test('parseDecision nunca detiene por una respuesta ilegible: falla hacia "seguir"',()=>{
  assert.deepEqual(parseDecision('esto no es JSON en absoluto'),{action:'seguir'});
  assert.deepEqual(parseDecision('```json\n{"accion":"detener"\n```'),{action:'seguir'});
  assert.deepEqual(parseDecision('```json\n{"accion":"cancelar"}\n```'),{action:'seguir'});
  assert.deepEqual(parseDecision('```json\n{"accion":"detener","motivo":"sin número"}\n```'),{action:'seguir'});
  assert.deepEqual(parseDecision('```json\n{"accion":"detener","subtarea":0,"motivo":"cero no vale"}\n```'),{action:'seguir'});
  assert.deepEqual(parseDecision('```json\n{"accion":"detener","subtarea":"dos","motivo":"no es número"}\n```'),{action:'seguir'});
});

test('buildSupervisionPrompt no repite la petición del usuario ni el plan',()=>{
  const subtasks=[{index:0,title:'Frente uno'},{index:1,title:'Frente dos'}];
  const events=[{type:'colision',file:'uno.txt',indexes:[0,1]}];
  const prompt=buildSupervisionPrompt({events,subtasks});
  assert.doesNotMatch(prompt,/PETICIÓN (DEL USUARIO|ORIGINAL DEL USUARIO):/i);
  assert.doesNotMatch(prompt,/resumen|subtareas|justificacion/i);
  assert.match(prompt,/Frente uno/);
  assert.match(prompt,/uno\.txt/);
  assert.match(prompt,/```json/);
  assert.match(prompt,/"accion":"seguir"/);
  assert.match(prompt,/"accion":"detener"/);
  assert.match(prompt,/descarta/i);
});

test('buildSupervisionPrompt describe una invasión con la sub-tarea implicada',()=>{
  const subtasks=[{index:0,title:'Frente uno'}];
  const prompt=buildSupervisionPrompt({events:[{type:'invasion',index:0,file:'fuera.txt'}],subtasks});
  assert.match(prompt,/Frente uno/);
  assert.match(prompt,/fuera\.txt/);
});

test('buildPlanPrompt ofrece el catálogo real y exige un único bloque JSON',()=>{
  const prompt=buildPlanPrompt({request:'Añade tests al módulo de memoria',connections,maxSubtasks:4,
    memory:'RECUERDO: el proyecto usa node:test',history:'usuario: hola'});
  assert.match(prompt,/gpt-5-codex/);
  assert.match(prompt,/sonnet/);
  assert.match(prompt,/```json/);
  assert.match(prompt,/Añade tests al módulo de memoria/);
  assert.match(prompt,/node:test/);
  assert.match(prompt,/4/);
  // El orquestador planifica, no ejecuta.
  assert.match(prompt,/no (modifiques|escribas)/i);
});

test('parsePlan devuelve una respuesta directa cuando el arquitecto contesta sin sub-tareas',()=>{
  const result=parsePlan('Ya lo tengo:\n```json\n{"respuesta":"El proyecto usa **node:test** y no tiene dependencias."}\n```',{connections});
  assert.equal(result.direct,true);
  assert.match(result.answer,/node:test/);
  assert.deepEqual(result.subtasks,[]);
  // Una respuesta vacía no vale como respuesta: el plan sigue siendo obligatorio.
  assert.throws(()=>parsePlan('```json\n{"respuesta":"   "}\n```',{connections}),PlanError);
  // Si vienen sub-tareas, el plan manda aunque también haya respuesta.
  const both=parsePlan('```json\n'+JSON.stringify({respuesta:'ignorada',resumen:'Plan',subtareas:[subtask()]})+'\n```',{connections});
  assert.equal(both.direct,false);
  assert.equal(both.subtasks.length,1);
});

test('parseJsonBlock sobrevive a un ``` dentro de una cadena de la respuesta',()=>{
  const text='Aquí va:\n```json\n{"respuesta":"Usa esto:\\n```js\\nfoo()\\n```\\nListo."}\n```';
  const {data}=parseJsonBlock(text);
  assert.ok(data,'el bloque cortado por el ``` interno se recupera por llaves balanceadas');
  assert.match(data.respuesta,/foo\(\)/);
  assert.equal(parsePlan(text,{connections}).direct,true);
  assert.equal(parseJsonBlock('sin json').data,undefined);
});

test('parsePlan conserva el contexto compartido y lo recorta',()=>{
  const text='```json\n'+JSON.stringify({resumen:'Plan',contexto:'c'.repeat(7000),subtareas:[subtask()]})+'\n```';
  const result=parsePlan(text,{connections});
  assert.equal(result.context.length,6000);
  assert.equal(parsePlan(plan([subtask()]),{connections}).context,'');
});

test('buildPlanPrompt ofrece la respuesta directa, pide contexto y avisa del modo de la tarea',()=>{
  const readOnly=buildPlanPrompt({request:'¿Qué hace store.mjs?',connections,readOnly:true});
  assert.match(readOnly,/"respuesta"/);
  assert.match(readOnly,/"contexto"/);
  assert.match(readOnly,/solo consulta/i);
  assert.match(readOnly,/modelos rápidos/i);
  const writable=buildPlanPrompt({request:'Añade tests',connections,readOnly:false});
  assert.match(writable,/permitido modificar archivos/i);
});

test('buildWorkPrompt distingue la carpeta real de la copia aislada e incluye el contexto',()=>{
  const base={request:'Añade tests',subtask:{role:'Probar',instructions:'Escribe tests',scope:['tests/'],readOnly:false}};
  const direct=buildWorkPrompt({...base,context:'Los tests usan node:test',direct:true});
  assert.match(direct,/directamente en la carpeta del proyecto/);
  assert.match(direct,/node:test/);
  assert.match(direct,/tests\//);
  const isolated=buildWorkPrompt({...base,direct:false});
  assert.match(isolated,/copia aislada/);
  const reading=buildWorkPrompt({...base,subtask:{...base.subtask,readOnly:true}});
  assert.match(reading,/no puedes modificar archivos/);
});

test('buildFixPrompt lleva la revisión y las indicaciones sin repetir la memoria',()=>{
  const prompt=buildFixPrompt({request:'Añade tests',subtask:{role:'Probar',instructions:'Escribe tests',scope:['tests/']},
    review:'Falta el caso vacío.\n\nVEREDICTO: NO INTEGRAR',feedback:'Cubre también null'});
  assert.match(prompt,/^CORRECCIÓN SOLICITADA/);
  assert.match(prompt,/Falta el caso vacío/);
  assert.match(prompt,/Cubre también null/);
  assert.doesNotMatch(prompt,/MEMORIA COMPARTIDA/);
});

test('buildReviewPrompt describe dónde está el revisor y lista los archivos nuevos sin diff',()=>{
  const subtasks=[{id:'a',index:0,title:'Directo',role:'Escribir',provider:'claude',model:'sonnet',status:'completed',text:'Hecho',
    patch:null,diff:{files:2,insertions:3,deletions:0,created:['nuevo.txt']},readOnly:false}];
  const integrated=buildReviewPrompt({request:'Haz X',subtasks,workspace:'integrated'});
  assert.match(integrated,/copia aislada del proyecto con todos los cambios/);
  assert.match(integrated,/ejecútalos/);
  const direct=buildReviewPrompt({request:'Haz X',subtasks,workspace:'project-direct'});
  assert.match(direct,/ya están aplicados en la carpeta del proyecto/);
  assert.match(direct,/nuevo\.txt/);
  const clean=buildReviewPrompt({request:'Haz X',subtasks,workspace:'project-clean'});
  assert.match(clean,/sin los cambios aplicados/);
  // Un parche largo se recorta y se dice dónde está el completo.
  const long=buildReviewPrompt({request:'Haz X',subtasks,patchText:{a:'x'.repeat(20000)},workspace:'integrated'});
  assert.match(long,/recortado/);
});

test('parseManualPlan valida el reparto hecho a mano con las mismas reglas que un plan',()=>{
  const result=parseManualPlan({review:false,context:'Usa node:test',subtasks:[
    {title:'API',provider:'codex',model:'gpt-5-codex',effort:'high',instructions:'Crea el endpoint',scope:'src/api.js, src/routes/'},
    {title:'Docs',provider:'claude',model:'inventado',effort:'ultra',instructions:'Documenta',readOnly:true,order:''}]},{connections});
  assert.equal(result.direct,false);
  assert.equal(result.review,false);
  assert.equal(result.context,'Usa node:test');
  assert.equal(result.summary,'Reparto hecho a mano.');
  assert.deepEqual(result.subtasks[0].scope,['src/api.js','src/routes/']);
  assert.equal(result.subtasks[0].role,'Sub-tarea asignada por el usuario');
  assert.equal(result.subtasks[0].effort,'high');
  assert.equal(result.subtasks[1].model,'opus','un modelo fuera del catálogo se corrige al predeterminado');
  assert.equal(result.subtasks[1].effort,null);
  assert.equal(result.subtasks[1].readOnly,true);
  assert.equal(result.subtasks[1].order,2);
  assert.equal(result.warnings.length,2);
  assert.throws(()=>parseManualPlan({subtasks:[]},{connections}),/al menos una sub-tarea/);
  assert.throws(()=>parseManualPlan({subtasks:[{title:'',provider:'codex',model:'gpt-5-codex',instructions:'x'}]},{connections}),PlanError);
  assert.throws(()=>parseManualPlan({subtasks:[{title:'t',provider:'gemini',model:'x',instructions:'x'}]},{connections}),/no es un agente/);
  assert.throws(()=>parseManualPlan({subtasks:Array.from({length:9},()=>({title:'t',provider:'codex',model:'gpt-5-codex',instructions:'x'}))},{connections}),/máximo 8/);
  assert.equal(parseManualPlan({subtasks:[{title:'t',provider:'codex',model:'gpt-5-codex',instructions:'x'}]},{connections,runReadOnly:true}).subtasks[0].readOnly,true,'el techo de permisos manda');
});

test('buildDirectPrompt solo lleva historial cuando no hay sesión que reanudar; buildSelfPrompt no replanifica',()=>{
  const fresh=buildDirectPrompt({request:'Hola',history:'usuario: antes',readOnly:true,resumed:false});
  assert.match(fresh,/modo directo/);
  assert.match(fresh,/usuario: antes/);
  assert.match(fresh,/no puedes modificar/);
  const resumed=buildDirectPrompt({request:'Hola',history:'usuario: antes',readOnly:false,resumed:true});
  assert.doesNotMatch(resumed,/usuario: antes/,'con sesión reanudada el historial ya está en el agente');
  assert.match(resumed,/Puedes modificar archivos/);
  const self=buildSelfPrompt({subtask:{title:'Tests',role:'Probar',instructions:'Escribe tests',scope:['tests/'],readOnly:false}});
  assert.match(self,/hazla tú ahora en esta misma sesión/);
  assert.match(self,/tests\//);
  assert.doesNotMatch(self,/PETICIÓN ORIGINAL|MEMORIA COMPARTIDA/);
});

const people=[{id:'p-ana',name:'Ana',role:'QA',notes:'tiene un móvil de pruebas'},{id:'p-luis',name:'Luis',role:'backend'}];

test('el plan del arquitecto puede asignar una sub-tarea a una persona del equipo, por nombre y sin distinguir mayúsculas',()=>{
  const text=plan([subtask(),{titulo:'Probar en móvil',proveedor:'persona',persona:'ana',rol:'QA',instrucciones:'Prueba el flujo',orden:2}]);
  const result=parsePlan(text,{connections,people});
  assert.equal(result.subtasks[1].human,true);
  assert.equal(result.subtasks[1].personId,'p-ana');
  assert.equal(result.subtasks[1].personName,'Ana');
  assert.equal(result.subtasks[1].provider,'persona');
  assert.equal(result.subtasks[1].model,null);
  assert.equal(result.subtasks[0].human,false);
  assert.throws(()=>parsePlan(plan([{...subtask(),proveedor:'persona',persona:'Nadie'}]),{connections,people}),/no está en el equipo/);
  assert.throws(()=>parsePlan(plan([{...subtask(),proveedor:'persona',persona:'Ana'}]),{connections}),/no está en el equipo/,'sin equipo no hay a quién asignar');
});

test('parseManualPlan acepta personas por identificador y buildPlanPrompt presenta el equipo',()=>{
  const result=parseManualPlan({subtasks:[{title:'Probar',provider:'persona',personId:'p-luis',instructions:'Prueba el despliegue'}]},{connections,people});
  assert.equal(result.subtasks[0].human,true);
  assert.equal(result.subtasks[0].personName,'Luis');
  assert.throws(()=>parseManualPlan({subtasks:[{title:'Probar',provider:'persona',personId:'p-x',instructions:'x'}]},{connections,people}),/no está en el equipo/);
  const prompt=buildPlanPrompt({request:'Saca la versión',connections,people});
  assert.match(prompt,/EQUIPO HUMANO DEL PROYECTO/);
  assert.match(prompt,/Ana · QA · tiene un móvil de pruebas/);
  assert.match(prompt,/codex\|claude\|persona/);
  assert.doesNotMatch(buildPlanPrompt({request:'Saca la versión',connections}),/EQUIPO HUMANO/);
});

test('la revisión y el trabajo de los agentes tienen en cuenta las partes de las personas',()=>{
  const subtasks=[
    {id:'a',index:0,title:'Código',role:'Programar',provider:'claude',model:'sonnet',status:'completed',text:'Hecho',patch:null,readOnly:false,human:false},
    {id:'h',index:1,title:'Probar en móvil',role:'QA',provider:'persona',personName:'Ana',status:'hecha',result:'Probado en un Pixel; falla el scroll',due:'2026-10-01',human:true}
  ];
  const review=buildReviewPrompt({request:'Haz X',subtasks,workspace:'project'});
  assert.match(review,/asignada a Ana \(persona\)/);
  assert.match(review,/Estado: Hecha · fecha límite 2026-10-01/);
  assert.match(review,/Probado en un Pixel/);
  assert.match(review,/no las ejecuta Mixto/);
  assert.match(review,/tal como está ahora/);
  const work=buildWorkPrompt({request:'Haz X',subtask:subtasks[0],teamNote:'- Ana: Probar en móvil'});
  assert.match(work,/ASIGNADAS A PERSONAS DEL EQUIPO/);
  assert.match(work,/Ana: Probar en móvil/);
});
