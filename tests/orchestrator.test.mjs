import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPlanPrompt,parsePlan,assignWaves,buildReviewPrompt,readVerdict,PlanError,buildSupervisionPrompt,parseDecision} from '../lib/orchestrator.mjs';

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
  assert.throws(()=>parsePlan(plan([subtask({instrucciones:'x'.repeat(4001)})]),{connections}),PlanError);
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
