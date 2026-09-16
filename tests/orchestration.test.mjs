import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import http from 'node:http';
import {buildZip} from '../lib/zip.mjs';
import {listFiles} from '../lib/update.mjs';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.dirname(here);
const agent=path.join(here,'fake-agent.mjs');
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{windowsHide:true,encoding:'utf8'});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

const GIT_ENV={...process.env,GIT_TERMINAL_PROMPT:'0'};
async function boot(t,{delay=600,scenario,remote=false,cloneOf=null,identity={name:'Mixto Test',email:'test@example.invalid'},appRoot=root,env={},noProject=false,reviewPolicy='always'}={}) {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mixto-orq-')));
  const projectsRoot=env.MIXTO_PROJECTS_ROOT||path.join(dir,'projects');if(!env.MIXTO_PROJECTS_ROOT)fs.mkdirSync(projectsRoot);
  const work=path.join(projectsRoot,'proyecto');
  let bare=null;
  if(noProject){}
  else if(cloneOf)execFileSync('git',['clone','--quiet',cloneOf,work],{env:GIT_ENV});
  else{fs.mkdirSync(work);git(work,'init','-b','main');}
  if(!noProject){git(work,'config','user.name',identity.name);
  git(work,'config','user.email',identity.email);
  git(work,'config','core.autocrlf','false');}
  if(!cloneOf&&!noProject){
    fs.writeFileSync(path.join(work,'base.txt'),'base\n');
    git(work,'add','base.txt');git(work,'commit','-m','inicial');
    if(remote){bare=path.join(dir,'remote.git');execFileSync('git',['init','--bare','-b','main',bare],{env:GIT_ENV});git(work,'remote','add','origin',bare);git(work,'push','-q','-u','origin','main');}
  }
  const port=20000+Math.floor(Math.random()*20000);
  const child=spawn(process.execPath,['server.mjs'],{cwd:appRoot,windowsHide:true,stdio:['ignore','pipe','pipe'],
    env:{...process.env,MIXTO_UPDATE_CHECK:'off',MIXTO_PORT:String(port),MIXTO_DATA_DIR:path.join(dir,'datos'),
      MIXTO_PROJECTS_ROOT:projectsRoot,
      ENGRAM_DATA_DIR:path.join(dir,'engram'),FAKE_AGENT_DELAY:String(delay),MIXTO_MAX_PARALLEL:'3',
      ...(scenario?{FAKE_AGENT_SCENARIO:scenario}:{}),
      // Esta prueba es del motor de orquestación: no debe tocar la memoria compartida real.
      MIXTO_ENGRAM_PATH:path.join(dir,'sin-engram.exe'),
      MIXTO_CODEX_PATH:JSON.stringify([process.execPath,agent,'codex']),
      MIXTO_CLAUDE_PATH:JSON.stringify([process.execPath,agent,'claude']),...env}});
  let log='';
  child.stdout.on('data',d=>{log+=d;});child.stderr.on('data',d=>{log+=d;});
  t.after(async()=>{
    try{child.kill();}catch{}
    await wait(300);
    try{fs.rmSync(dir,{recursive:true,force:true});}catch{}
  });
  const origin=`http://127.0.0.1:${port}`;
  let cookie='';
  for(let attempt=0;attempt<80&&!cookie;attempt++) {
    try {
      const page=await fetch(origin+'/',{headers:{Host:`127.0.0.1:${port}`}});
      cookie=(page.headers.get('set-cookie')||'').split(';')[0];
    } catch {await wait(150);}
  }
  assert.ok(cookie,'el servidor local no arrancó: '+log);
  // Un servidor reiniciado estrena secreto: la cookie se renueva como haría el navegador al recargar.
  const refreshCookie=async()=>{const page=await fetch(origin+'/');cookie=(page.headers.get('set-cookie')||'').split(';')[0];};
  const call=async(route,body,method=body===undefined?'GET':'POST')=>{
    const response=await fetch(`${origin}/api/${route}`,{method,
      headers:{cookie,...(body===undefined?{}:{'Content-Type':'application/json','X-Mixto-Client':'1'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||'fallo '+response.status);
    return data;
  };
  // Las conexiones se consultan al arrancar; espera a que el catálogo falso esté listo.
  let state;
  for(let attempt=0;attempt<80;attempt++) {
    state=await call('state');
    if(state.connections.claude.connected&&state.connections.codex.connected)break;
    await wait(150);
  }
  assert.ok(state.connections.claude.connected,'el agente falso no se reportó conectado: '+log);
  // Nunca usar el proyecto por defecto: apunta a la carpeta de Mixto, no a esta copia de prueba.
  const project=noProject?null:await call('projects',{name:'Proyecto de prueba',path:work,description:''});
  // Las pruebas históricas cuentan con revisión en cada tarea; la política por defecto de la app se prueba aparte.
  if(reviewPolicy)await call('settings',{reviewPolicy});
  return {call,refreshCookie,work,dir,project,origin,cookie,bare,log:()=>log,
    until:async predicate=>{
      for(let attempt=0;attempt<200;attempt++) {
        const current=await call('state');
        if(predicate(current))return current;
        await wait(150);
      }
      throw new Error('el estado esperado no llegó. Registro:\n'+log);
    }};
}

const runOf=state=>state.runs.at(-1);

test('the API discovers and creates projects only inside the managed projects root',async t=>{
  const {call,dir,project}=await boot(t,{delay:50});
  const root=fs.realpathSync(path.join(dir,'projects'));
  const state=await call('state');
  assert.deepEqual(state.app.projectsRoot,{path:root,available:true});
  assert.ok(state.projects.some(item=>item.id===project.id&&item.path===fs.realpathSync(path.join(root,'proyecto'))));
  const created=await call('projects',{name:'Paper shop POS',directoryName:'tpv-papeleria',description:''});
  assert.equal(created.path,fs.realpathSync(path.join(root,'tpv-papeleria')));
  await assert.rejects(call('projects',{name:'Escape',directoryName:'../escape',description:''}),/Project folder/);
  assert.equal(fs.existsSync(path.join(dir,'escape')),false);
});

test('un run orquestado planifica, espera tu aprobación, trabaja en paralelo e integra',async t=>{
  const delay=700;
  const {call,work,until,project,dir}=await boot(t,{delay});
  const conversation=await call('conversations',{projectId:project.id});
  await call('run',{conversationId:conversation.id,prompt:'Reparte este trabajo',readOnly:false,
    orchestrator:{provider:'claude',model:'claude-fake',effort:'medium'}});

  // 1. El plan se presenta y nada arranca hasta que el usuario aprueba.
  let state=await until(s=>runOf(s).status==='awaiting-plan');
  let run=runOf(state);
  assert.equal(run.subtasks.length,2);
  assert.equal(run.plan.status,'ready');
  assert.equal(run.isolation.kind,'worktree');
  assert.deepEqual(run.subtasks.map(s=>s.status),['queued','queued']);
  assert.equal(fs.existsSync(path.join(work,'uno.txt')),false,'no se toca nada antes de aprobar');

  // 2. El usuario economiza: cambia el modelo de una sub-tarea antes de empezar.
  await call('plan',{runId:run.id,approve:true,subtasks:[
    {id:run.subtasks[0].id,model:'claude-fake-rapido',effort:'low'},
    {id:run.subtasks[1].id,model:run.subtasks[1].model,effort:run.subtasks[1].effort}]});

  state=await until(s=>['completed','error'].includes(runOf(s).status));
  run=runOf(state);
  assert.equal(run.status,'completed',JSON.stringify(run.subtasks.map(s=>s.error)));
  assert.equal(run.subtasks[0].model,'claude-fake-rapido','se respeta el modelo elegido por el usuario');
  assert.equal(run.subtasks[0].effort,'low');

  // 3. Las dos sub-tareas se solaparon en el tiempo: no se ejecutaron en fila.
  assert.equal(run.waves.length,1,'ambas escrituras caben en una sola ola');
  const [uno,dos]=run.subtasks.map(s=>({desde:Date.parse(s.startedAt),hasta:Date.parse(s.finishedAt)}));
  assert.ok(uno.desde<dos.hasta&&dos.desde<uno.hasta,
    `las sub-tareas no se solaparon: ${JSON.stringify(run.subtasks.map(s=>[s.startedAt,s.finishedAt]))}`);
  const span=Math.max(uno.hasta,dos.hasta)-Math.min(uno.desde,dos.desde);
  assert.ok(span<delay*2,`la fase de trabajo tardó ${span}ms; en fila habría tardado al menos ${delay*2}ms`);

  // 4. El orquestador revisó y, sin conflicto, se integró en la carpeta real sin commits.
  assert.equal(run.review.status,'integrar');
  assert.equal(run.review.integration.conflicts.length,0);
  assert.equal(fs.readFileSync(path.join(work,'uno.txt'),'utf8'),'escrito por la sub-tarea uno.txt\n');
  assert.equal(fs.readFileSync(path.join(work,'dos.txt'),'utf8'),'escrito por la sub-tarea dos.txt\n');
  assert.equal(git(work,'log','--oneline').trim().split('\n').length,1,'el historial del usuario queda intacto');

  // 5. Cada sub-tarea dejó su propio mensaje, y el plan y la revisión el suyo.
  const kinds=state.messages.filter(m=>m.runId===run.id).map(m=>m.kind||m.role);
  assert.deepEqual(kinds,['user','plan','work','work','review']);

  // 6. No quedan copias de trabajo ni worktrees registrados. La limpieza ocurre justo después
  // de marcar la tarea como terminada, así que se espera a que acabe en vez de leerla al vuelo.
  let listed='',leftover=true;
  for(let attempt=0;attempt<40;attempt++) {
    listed=git(work,'worktree','list');
    leftover=fs.existsSync(path.join(dir,'datos','wt'));
    if(!/wt/.test(listed)&&!leftover)break;
    await wait(150);
  }
  assert.doesNotMatch(listed,/wt/);
  assert.equal(leftover,false,'la carpeta de copias de trabajo debería quedar vacía');

  // 7. La memoria guarda un único registro consolidado del run, no uno por sub-tarea.
  const automatic=state.memories.filter(m=>m.automatic&&m.conversationId===conversation.id);
  assert.equal(automatic.length,1);
  assert.match(automatic[0].content,/Frente uno/);
  assert.match(automatic[0].content,/Frente dos/);

  // 8. El revisor trabajó en la copia integrada, y el consumo de cada turno y de la tarea es visible.
  assert.equal(run.review.workspace,'integrated');
  assert.equal(run.plan.context,'El proyecto es una carpeta de prueba con base.txt.');
  assert.equal(run.usage.turns,4,'plan, dos sub-tareas y revisión');
  assert.equal(run.usage.total,4*150);
  assert.ok(run.usage.costUsd>0.04);
  for(const m of state.messages.filter(m=>m.runId===run.id&&m.role==='assistant'))assert.equal(m.usage.total,150);
  assert.deepEqual(state.connections.codex.limits.windows.map(w=>w.usedPercent),[34,12],'la cuota de Codex llega normalizada');
});

test('una pregunta se responde desde el plan: un turno, sin sub-tareas ni revisión',async t=>{
  const {call,work,until,project}=await boot(t,{delay:50,scenario:'directa'});
  const conversation=await call('conversations',{projectId:project.id});
  await call('run',{conversationId:conversation.id,prompt:'¿Qué es este proyecto?',readOnly:true,
    orchestrator:{provider:'claude',model:'claude-fake',effort:'medium'}});
  const state=await until(s=>['completed','error','awaiting-plan'].includes(runOf(s).status));
  const run=runOf(state);
  assert.equal(run.status,'completed',run.error);
  assert.equal(run.plan.status,'direct');
  assert.deepEqual(run.subtasks,[]);
  assert.equal(run.review,null);
  assert.match(run.answer,/proyecto de prueba/);
  assert.match(run.answer,/console\.log\(1\)/,'el bloque de código dentro de la respuesta sobrevive');
  assert.deepEqual(state.messages.filter(m=>m.runId===run.id).map(m=>m.kind||m.role),['user','answer']);
  assert.equal(run.usage.turns,1);
  assert.equal(fs.existsSync(path.join(work,'uno.txt')),false);
  const automatic=state.memories.filter(m=>m.automatic&&m.conversationId===conversation.id);
  assert.equal(automatic.length,1);
  assert.match(automatic[0].content,/Respuesta directa/);
});

test('un solo escritor del mismo agente: el arquitecto lo hace en su sesión, en la carpeta real, sin copia ni parche',async t=>{
  const {call,work,until,project,dir}=await boot(t,{delay:50,scenario:'unica'});
  const conversation=await call('conversations',{projectId:project.id});
  await call('run',{conversationId:conversation.id,prompt:'Escribe solo.txt',readOnly:false,
    orchestrator:{provider:'claude',model:'claude-fake',effort:'medium'}});
  let state=await until(s=>runOf(s).status==='awaiting-plan');
  let run=runOf(state);
  assert.equal(run.subtasks.length,1);
  await call('plan',{runId:run.id,approve:true,subtasks:[]});
  state=await until(s=>['completed','error'].includes(runOf(s).status));
  run=runOf(state);
  assert.equal(run.status,'completed',JSON.stringify(run.subtasks.map(s=>s.error)));
  assert.deepEqual(run.isolation.roots,{},'no se creó ninguna copia aislada');
  assert.equal(run.subtasks[0].cwd,fs.realpathSync(work));
  assert.equal(run.subtasks[0].patch,null);
  assert.equal(run.subtasks[0].diff.files,1,'el diff desde la instantánea es la evidencia del revisor');
  assert.deepEqual(run.subtasks[0].diff.created,['solo.txt']);
  assert.equal(run.review.workspace,'project-direct');
  assert.equal(run.review.status,'integrar');
  assert.equal(run.review.integration,null,'no hay parche que integrar: el trabajo ya está en la carpeta');
  assert.equal(fs.readFileSync(path.join(work,'solo.txt'),'utf8'),'escrito por la sub-tarea solo.txt\n');
  assert.equal(fs.existsSync(path.join(dir,'datos','wt')),false);
  assert.equal(run.subtasks[0].self,true,'misma sesión que el arquitecto: no arranca un trabajador en frío');
  assert.equal(run.subtasks[0].sessionKey,null);
  assert.match(run.events.map(e=>e.text).join('\n'),/propia sesión/);
  assert.equal(run.subtasks[0].fixable,true,'una sub-tarea directa con sesión se puede corregir');
  assert.deepEqual(state.messages.filter(m=>m.runId===run.id).map(m=>m.kind||m.role),['user','plan','work','review']);
});

test('un solo escritor del otro agente trabaja en la carpeta real y guarda su sesión para reanudarla',async t=>{
  const {call,work,until,project}=await boot(t,{delay:50,scenario:'unica-codex'});
  const conversation=await call('conversations',{projectId:project.id});
  await call('run',{conversationId:conversation.id,prompt:'Escribe solo.txt',readOnly:false,
    orchestrator:{provider:'claude',model:'claude-fake',effort:'medium'}});
  let run=runOf(await until(s=>runOf(s).status==='awaiting-plan'));
  assert.equal(run.subtasks[0].provider,'codex');
  await call('plan',{runId:run.id,approve:true,subtasks:[]});
  const state=await until(s=>['completed','error'].includes(runOf(s).status));
  run=runOf(state);
  assert.equal(run.status,'completed',JSON.stringify(run.subtasks.map(s=>s.error)));
  assert.equal(run.subtasks[0].self,false);
  assert.equal(run.subtasks[0].cwd,fs.realpathSync(work));
  assert.deepEqual(run.isolation.roots,{});
  assert.equal(fs.readFileSync(path.join(work,'solo.txt'),'utf8'),'escrito por la sub-tarea solo.txt\n');
  const conv=state.conversations.find(c=>c.id===conversation.id);
  assert.ok(Object.values(conv.sessions).includes('native-codex'),'la sesión nativa del trabajador queda guardada');
  assert.deepEqual(state.messages.filter(m=>m.runId===run.id&&m.kind==='work').map(m=>m.provider),['codex']);
});

test('con la aprobación automática activada, un plan de una sola sub-tarea arranca solo',async t=>{
  const {call,work,until,project}=await boot(t,{delay:50,scenario:'auto'});
  await call('settings',{autoApproveSingle:true});
  const conversation=await call('conversations',{projectId:project.id});
  await call('run',{conversationId:conversation.id,prompt:'Escribe solo.txt',readOnly:false,
    orchestrator:{provider:'claude',model:'claude-fake',effort:'medium'}});
  const state=await until(s=>['completed','error','awaiting-plan'].includes(runOf(s).status));
  const run=runOf(state);
  assert.equal(run.status,'completed',run.error||run.status);
  assert.equal(run.plan.autoApproved,true);
  assert.match(run.events.map(e=>e.text).join('\n'),/aprobado automáticamente/);
  assert.equal(fs.readFileSync(path.join(work,'solo.txt'),'utf8'),'escrito por la sub-tarea solo.txt\n');
  assert.equal(state.settings.autoApproveSingle,true);
});

test('una única sub-tarea de consulta no paga revisión',async t=>{
  const {call,until,project}=await boot(t,{delay:50,scenario:'lectura'});
  const conversation=await call('conversations',{projectId:project.id});
  await call('run',{conversationId:conversation.id,prompt:'Describe base.txt',readOnly:true,
    orchestrator:{provider:'claude',model:'claude-fake',effort:'medium'}});
  let run=runOf(await until(s=>runOf(s).status==='awaiting-plan'));
  await call('plan',{runId:run.id,approve:true,subtasks:[]});
  const state=await until(s=>['completed','error'].includes(runOf(s).status));
  run=runOf(state);
  assert.equal(run.status,'completed',run.error);
  assert.equal(run.review,null);
  assert.equal(run.usage.turns,2,'plan y consulta; ninguna revisión');
  assert.deepEqual(state.messages.filter(m=>m.runId===run.id).map(m=>m.kind||m.role),['user','plan','work']);
  assert.equal(run.subtasks[0].fixable,false,'una consulta no se corrige');
});

test('corregir una sub-tarea reanuda su sesión en su copia, vuelve a revisar e integra',async t=>{
  const {call,work,until,project,dir}=await boot(t,{delay:50,scenario:'corregir'});
  const conversation=await call('conversations',{projectId:project.id});
  await call('run',{conversationId:conversation.id,prompt:'Reparte este trabajo',readOnly:false,
    orchestrator:{provider:'claude',model:'claude-fake',effort:'medium'}});
  let run=runOf(await until(s=>runOf(s).status==='awaiting-plan'));
  await call('plan',{runId:run.id,approve:true,subtasks:run.subtasks.map(s=>({id:s.id,model:s.model,effort:s.effort}))});
  let state=await until(s=>['completed','error'].includes(runOf(s).status));
  run=runOf(state);
  // 1. Primera vuelta: el revisor rechaza, los parches quedan aparte y las copias sobreviven para corregir.
  assert.equal(run.status,'completed',run.error);
  assert.equal(run.review.status,'no-integrar');
  assert.equal(run.review.integration.applied.length,0);
  assert.equal(fs.existsSync(path.join(work,'uno.txt')),false,'nada llegó a la carpeta real');
  assert.ok(fs.existsSync(run.isolation.roots[0]),'la copia de la sub-tarea sigue ahí');
  assert.equal(run.subtasks[0].fixable,true);
  assert.equal(run.subtasks[1].fixable,true);
  assert.ok(run.subtasks[0].sessionId,'la sesión nativa de la sub-tarea aislada se conserva');
  const turnsBefore=run.usage.turns;
  // 2. Corregir solo la primera: ni plan nuevo ni segunda sub-tarea repetida.
  await call('fix',{runId:run.id,subtaskId:run.subtasks[0].id,feedback:'Cámbialo'});
  state=await until(s=>runOf(s).status==='running'||['completed','error'].includes(runOf(s).status)&&runOf(s).usage.turns>turnsBefore);
  state=await until(s=>['completed','error'].includes(runOf(s).status)&&runOf(s).usage.turns>turnsBefore);
  run=runOf(state);
  assert.equal(run.status,'completed',run.error);
  assert.equal(run.usage.turns,turnsBefore+2,'una corrección y una revisión');
  assert.equal(run.review.status,'integrar');
  assert.equal(run.review.integration.applied.length,2);
  assert.equal(fs.readFileSync(path.join(work,'uno.txt'),'utf8'),'corregido por la sub-tarea uno.txt\n');
  assert.equal(fs.readFileSync(path.join(work,'dos.txt'),'utf8'),'escrito por la sub-tarea dos.txt\n','la otra sub-tarea no se repitió');
  assert.equal(git(work,'log','--oneline').trim().split('\n').length,1);
  // 3. Historial completo en la conversación, un solo registro de memoria y copias recogidas.
  const kinds=state.messages.filter(m=>m.runId===run.id).map(m=>m.kind||m.role);
  assert.deepEqual(kinds,['user','plan','work','work','review','fix','work','review']);
  assert.equal(state.memories.filter(m=>m.automatic&&m.conversationId===conversation.id).length,1);
  for(let attempt=0;attempt<40&&fs.existsSync(path.join(dir,'datos','wt'));attempt++)await wait(150);
  assert.equal(fs.existsSync(path.join(dir,'datos','wt')),false);
  assert.equal(run.subtasks[0].fixable,false,'sin copia no hay nada que corregir');
  await assert.rejects(call('fix',{runId:run.id,subtaskId:run.subtasks[0].id,feedback:''}),/ya no se puede corregir/);
});

test('el arquitecto detiene una sub-tarea que colisiona con otra, sin tumbar el run',async t=>{
  const delay=2200;
  const {call,work,until,project}=await boot(t,{delay,scenario:'colision'});
  const conversation=await call('conversations',{projectId:project.id});
  await call('run',{conversationId:conversation.id,prompt:'Provoca una colisión',readOnly:false,
    orchestrator:{provider:'claude',model:'claude-fake',effort:'medium'}});

  let state=await until(s=>runOf(s).status==='awaiting-plan');
  let run=runOf(state);
  assert.equal(run.subtasks.length,2);
  await call('plan',{runId:run.id,approve:true,subtasks:run.subtasks.map(s=>({id:s.id,model:s.model,effort:s.effort}))});

  state=await until(s=>['completed','error'].includes(runOf(s).status));
  run=runOf(state);
  assert.equal(run.status,'completed',JSON.stringify(run.subtasks.map(s=>[s.status,s.error])));
  assert.equal(run.subtasks[0].status,'stopped');
  assert.equal(run.subtasks[0].stage,'Detenida por el arquitecto');
  assert.match(run.subtasks[0].error,/compartido\.txt/);
  assert.equal(run.subtasks[1].status,'completed');
  assert.equal(fs.readFileSync(path.join(work,'compartido.txt'),'utf8'),'escrito por la sub-tarea compartido.txt\n');
  // The architect kept the same session across the plan, the live supervision turn and the review.
  assert.match(run.events.map(e=>e.text).join('\n'),/detiene la sub-tarea/);
});

test('descartar el plan no ejecuta ninguna sub-tarea',async t=>{
  const {call,work,until,project}=await boot(t,{delay:100});
  const conversation=await call('conversations',{projectId:project.id});
  await call('run',{conversationId:conversation.id,prompt:'Reparte este trabajo',readOnly:false,
    orchestrator:{provider:'claude',model:'claude-fake',effort:'medium'}});
  let run=runOf(await until(s=>runOf(s).status==='awaiting-plan'));
  await call('plan',{runId:run.id,approve:false});
  run=runOf(await until(s=>runOf(s).status==='cancelled'));
  assert.equal(run.plan.status,'rejected');
  assert.deepEqual(run.subtasks.map(s=>s.status),['queued','queued']);
  assert.equal(fs.existsSync(path.join(work,'uno.txt')),false);
  assert.equal(fs.existsSync(path.join(work,'dos.txt')),false);
});

test('el modo directo habla con un solo agente, sin plan ni revisión, y conserva la sesión por agente',async t=>{
  const {call,work,until,project}=await boot(t,{delay:50});
  const conversation=await call('conversations',{projectId:project.id});
  await call('run',{conversationId:conversation.id,prompt:'Hola, ¿qué ves?',readOnly:true,mode:'directo',
    orchestrator:{provider:'claude',model:'claude-fake',effort:'medium'}});
  let state=await until(s=>['completed','error'].includes(runOf(s).status));
  let run=runOf(state);
  assert.equal(run.status,'completed',run.error);
  assert.equal(run.mode,'directo');
  assert.equal(run.plan.status,'direct-mode');
  assert.equal(run.review,null);
  assert.equal(run.usage.turns,1);
  assert.deepEqual(state.messages.filter(m=>m.runId===run.id).map(m=>m.kind||m.role),['user','direct']);
  assert.equal(run.subtasks[0].fixable,false,'en directo se sigue conversando, no se corrige');
  let conv=state.conversations.find(c=>c.id===conversation.id);
  assert.equal(conv.sessions['direct:claude:read'],'native-claude');
  // Segundo turno con permiso de escritura y otro modelo: el agente trabaja en la carpeta real.
  await call('run',{conversationId:conversation.id,prompt:'ARCHIVO:directo.txt',readOnly:false,mode:'directo',
    orchestrator:{provider:'claude',model:'claude-fake-rapido',effort:'low'}});
  state=await until(s=>s.runs.length===2&&['completed','error'].includes(runOf(s).status));
  run=runOf(state);
  assert.equal(run.status,'completed',run.error);
  assert.equal(fs.readFileSync(path.join(work,'directo.txt'),'utf8'),'escrito por la sub-tarea directo.txt\n');
  conv=state.conversations.find(c=>c.id===conversation.id);
  assert.equal(conv.sessions['direct:claude:work'],'native-claude');
  assert.equal(state.memories.filter(m=>m.automatic&&m.conversationId===conversation.id).length,2);
});

test('reparto a mano: el usuario asigna cada sub-tarea a un agente y el principal revisa el conjunto',async t=>{
  const {call,work,until,project}=await boot(t,{delay:300});
  const conversation=await call('conversations',{projectId:project.id});
  await call('run',{conversationId:conversation.id,prompt:'Escribe dos archivos',readOnly:false,mode:'manual',
    orchestrator:{provider:'claude',model:'claude-fake',effort:'medium'},
    plan:{review:true,subtasks:[
      {title:'Parte de Codex',provider:'codex',model:'codex-fake',effort:'high',instructions:'ARCHIVO:uno.txt',scope:'uno.txt'},
      {title:'Parte de Claude',provider:'claude',model:'claude-fake-rapido',effort:'low',instructions:'ARCHIVO:dos.txt',scope:'dos.txt, docs/'}]}});
  const state=await until(s=>['completed','error'].includes(runOf(s).status));
  const run=runOf(state);
  assert.equal(run.status,'completed',JSON.stringify(run.subtasks.map(s=>s.error)));
  assert.equal(run.mode,'manual');
  assert.equal(run.plan.status,'manual');
  assert.deepEqual(run.subtasks.map(s=>[s.provider,s.model,s.effort]),[['codex','codex-fake','high'],['claude','claude-fake-rapido','low']]);
  assert.deepEqual(run.subtasks[1].scope,['dos.txt','docs/']);
  assert.equal(run.waves.length,1,'dos escritores con alcances distintos trabajan a la vez');
  assert.equal(Object.keys(run.isolation.roots).length,2);
  assert.equal(run.review.status,'integrar');
  assert.equal(run.review.integration.applied.length,2);
  assert.equal(fs.readFileSync(path.join(work,'uno.txt'),'utf8'),'escrito por la sub-tarea uno.txt\n');
  assert.equal(fs.readFileSync(path.join(work,'dos.txt'),'utf8'),'escrito por la sub-tarea dos.txt\n');
  assert.equal(run.usage.turns,3,'dos sub-tareas y la revisión; ningún turno de planificación');
  const messages=state.messages.filter(m=>m.runId===run.id);
  assert.deepEqual(messages.map(m=>m.kind||m.role),['manual','work','work','review']);
  assert.match(messages[0].content,/Reparto a mano/);
  assert.match(messages[0].content,/Parte de Codex · Codex codex-fake/);
  await assert.rejects(call('run',{conversationId:conversation.id,prompt:'Sin sub-tareas',readOnly:false,mode:'manual',
    orchestrator:{provider:'claude',model:'claude-fake'},plan:{subtasks:[]}}),/al menos una sub-tarea/);
});

test('reparto a mano sin revisión: los cambios esperan a que el usuario los aplique',async t=>{
  const {call,work,until,project,dir}=await boot(t,{delay:50});
  const conversation=await call('conversations',{projectId:project.id});
  await call('run',{conversationId:conversation.id,prompt:'Escribe dos archivos',readOnly:false,mode:'manual',
    orchestrator:{provider:'codex',model:'codex-fake',effort:null},
    plan:{review:false,subtasks:[
      {title:'Uno',provider:'claude',model:'claude-fake',instructions:'ARCHIVO:uno.txt'},
      {title:'Dos',provider:'codex',model:'codex-fake',instructions:'ARCHIVO:dos.txt'}]}});
  const state=await until(s=>['completed','error'].includes(runOf(s).status));
  const run=runOf(state);
  assert.equal(run.status,'completed',run.error);
  assert.equal(run.usage.turns,2,'sin revisión no hay turno del principal');
  assert.equal(run.review.status,'sin-revisar');
  assert.deepEqual(run.review.integration,{applied:[],conflicts:[]});
  assert.equal(fs.existsSync(path.join(work,'uno.txt')),false,'nada se aplica sin que el usuario decida');
  assert.ok(fs.existsSync(run.isolation.roots[0]),'las copias esperan');
  const result=await call('integrate',{runId:run.id});
  assert.equal(result.applied.length,2);
  assert.equal(fs.readFileSync(path.join(work,'uno.txt'),'utf8'),'escrito por la sub-tarea uno.txt\n');
  for(let attempt=0;attempt<40&&fs.existsSync(path.join(dir,'datos','wt'));attempt++)await wait(150);
  assert.equal(fs.existsSync(path.join(dir,'datos','wt')),false);
});

test('en el plan del arquitecto se puede reasignar una sub-tarea al otro agente o limitarla a solo lectura',async t=>{
  const {call,work,until,project}=await boot(t,{delay:50});
  const conversation=await call('conversations',{projectId:project.id});
  await call('run',{conversationId:conversation.id,prompt:'Reparte este trabajo',readOnly:false,
    orchestrator:{provider:'claude',model:'claude-fake',effort:'medium'}});
  let run=runOf(await until(s=>runOf(s).status==='awaiting-plan'));
  assert.deepEqual(run.subtasks.map(s=>s.provider),['claude','claude']);
  await call('plan',{runId:run.id,approve:true,subtasks:[
    {id:run.subtasks[0].id,provider:'codex',model:'codex-fake',effort:'high'},
    {id:run.subtasks[1].id,provider:'claude',model:run.subtasks[1].model,effort:run.subtasks[1].effort,readOnly:true}]});
  const state=await until(s=>['completed','error'].includes(runOf(s).status));
  run=runOf(state);
  assert.equal(run.status,'completed',JSON.stringify(run.subtasks.map(s=>s.error)));
  assert.deepEqual(run.subtasks.map(s=>[s.provider,s.model,s.effort,s.readOnly]),[['codex','codex-fake','high',false],['claude','claude-fake','medium',true]]);
  const events=run.events.map(e=>e.text).join('\n');
  assert.match(events,/reasignada a Codex/);
  assert.match(events,/limitada a solo lectura/);
  // Con un solo escritor ya no hace falta aislar: Codex escribe en la carpeta real; la consulta va antes.
  assert.deepEqual(run.isolation.roots,{});
  assert.equal(run.waves.length,2,'primero la consulta, después el único escritor');
  assert.equal(run.subtasks[1].diff,null,'una sub-tarea de solo lectura no deja diff que revisar');
  assert.equal(fs.readFileSync(path.join(work,'uno.txt'),'utf8'),'escrito por la sub-tarea uno.txt\n');
  assert.deepEqual(state.messages.filter(m=>m.runId===run.id&&m.kind==='work').map(m=>m.provider),['claude','codex']);
});

test('el tope de tokens detiene la tarea al superarse y lo explica',async t=>{
  const {call,until,project}=await boot(t,{delay:50});
  await call('settings',{tokenBudget:200});
  const conversation=await call('conversations',{projectId:project.id});
  await call('run',{conversationId:conversation.id,prompt:'Reparte este trabajo',readOnly:false,
    orchestrator:{provider:'claude',model:'claude-fake',effort:'medium'}});
  let run=runOf(await until(s=>runOf(s).status==='awaiting-plan'));
  await call('plan',{runId:run.id,approve:true,subtasks:[]});
  const state=await until(s=>['completed','error','cancelled'].includes(runOf(s).status));
  run=runOf(state);
  assert.equal(run.status,'cancelled');
  assert.equal(run.budgetExceeded,true);
  assert.match(run.error,/tope de 200 tokens/);
  assert.equal(run.stage,'Detenida por tope de consumo');
  assert.ok(run.usage.total>200);
  assert.ok(run.usage.turns<=3,'como mucho el plan y las dos sub-tareas; nunca la revisión');
  assert.equal(run.review,null);
  assert.equal(state.settings.tokenBudget,200);
  await assert.rejects(call('settings',{tokenBudget:-5}),/Tope de tokens/);
});

test('el servidor empuja el estado por SSE en cuanto cambia, sin sondeo',async t=>{
  const {call,project,origin,cookie}=await boot(t,{delay:50});
  const response=await fetch(origin+'/api/events',{headers:{cookie}});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'text/event-stream; charset=utf-8');
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let text='';
  while(!/event: state\ndata: [^\n]+\n\n/.test(text)){const {value,done}=await reader.read();if(done)break;text+=decoder.decode(value,{stream:true});}
  assert.match(text,/^retry: 2000\n\n/);
  assert.match(text,/event: state\ndata: \{"version":1/);
  await call('memories',{projectId:project.id,title:'Nota',content:'Empujada por SSE'});
  let more='';
  for(let attempt=0;attempt<40&&!more.includes('Empujada por SSE');attempt++){const {value,done}=await reader.read();if(done)break;more+=decoder.decode(value,{stream:true});}
  assert.match(more,/Empujada por SSE/,'el cambio llegó por el flujo de eventos');
  await reader.cancel();
  const unauthenticated=await fetch(origin+'/api/events');
  assert.equal(unauthenticated.status,401);
});

test('el equipo del proyecto: alta, edición, pertenencia a varios proyectos y baja',async t=>{
  const {call,project}=await boot(t,{delay:50});
  const ana=await call('people',{name:'Ana',role:'QA',email:'ana@example.invalid',notes:'móvil de pruebas',projectId:project.id});
  let state=await call('state');
  assert.ok(state.people.some(p=>p.id===ana.id&&p.name==='Ana'));
  assert.deepEqual(state.projects.find(p=>p.id===project.id).members,[ana.id]);
  await assert.rejects(call('people',{name:'Luis',email:'no-es-correo',projectId:project.id}),/Correo/);
  await call('people/'+ana.id,{name:'Ana G.',role:'QA móvil'},'PATCH');
  const other=await call('projects',{name:'Otro',directoryName:'otro',description:''});
  await call('members',{projectId:other.id,personId:ana.id});
  state=await call('state');
  assert.equal(state.people.find(p=>p.id===ana.id).name,'Ana G.');
  assert.equal(state.people.find(p=>p.id===ana.id).email,'ana@example.invalid','los campos no enviados se conservan');
  assert.deepEqual(state.projects.find(p=>p.id===other.id).members,[ana.id]);
  await call('members',{projectId:other.id,personId:ana.id,remove:true});
  await call('people/'+ana.id,{},'DELETE');
  state=await call('state');
  assert.equal(state.people.length,0);
  assert.deepEqual(state.projects.find(p=>p.id===project.id).members,[]);
});

test('reparto a mano entre un agente y una persona: la parte humana queda pendiente, se anota y se revisa de nuevo',async t=>{
  const {call,work,until,project}=await boot(t,{delay:50});
  const ana=await call('people',{name:'Ana',role:'QA',projectId:project.id});
  const conversation=await call('conversations',{projectId:project.id});
  await call('run',{conversationId:conversation.id,prompt:'Saca la versión',readOnly:false,mode:'manual',
    orchestrator:{provider:'claude',model:'claude-fake',effort:'medium'},
    plan:{review:true,subtasks:[
      {title:'Código',provider:'codex',model:'codex-fake',instructions:'ARCHIVO:uno.txt'},
      {title:'Probar en móvil',provider:'persona',personId:ana.id,instructions:'Prueba el flujo en un móvil real.',scope:'app/'}]}});
  let state=await until(s=>['completed','error'].includes(runOf(s).status));
  let run=runOf(state);
  assert.equal(run.status,'completed',run.error);
  assert.equal(run.stage,'Pendiente de 1 persona');
  const human=run.subtasks[1];
  assert.equal(human.human,true);assert.equal(human.personName,'Ana');assert.equal(human.status,'pendiente');
  assert.equal(human.cwd,null,'una persona no tiene copia ni carpeta de trabajo');
  assert.equal(human.fixable,false);
  assert.deepEqual(run.waves,[[run.subtasks[0].id]],'solo el agente entra en las olas');
  assert.equal(fs.readFileSync(path.join(work,'uno.txt'),'utf8'),'escrito por la sub-tarea uno.txt\n');
  assert.equal(run.review.status,'integrar');
  assert.equal(run.usage.turns,2,'agente y revisión; la persona no consume');
  assert.match(state.messages.find(m=>m.runId===run.id&&m.kind==='manual').content,/Probar en móvil · Ana \(persona\)/);
  // La persona termina: se anota su resultado y la etapa de la tarea cambia sin gastar ningún turno.
  await assert.rejects(call('subtask',{runId:run.id,subtaskId:run.subtasks[0].id,status:'hecha'}),/asignadas a personas/);
  await assert.rejects(call('subtask',{runId:run.id,subtaskId:human.id,status:'terminada'}),/Estado no válido/);
  await assert.rejects(call('subtask',{runId:run.id,subtaskId:human.id,due:'mañana'}),/AAAA-MM-DD/);
  await call('subtask',{runId:run.id,subtaskId:human.id,status:'hecha',result:'Probado en un Pixel; todo bien',due:'2026-10-01'});
  state=await call('state');run=runOf(state);
  assert.equal(run.stage,'Completado');
  assert.equal(run.subtasks[1].status,'hecha');assert.equal(run.subtasks[1].due,'2026-10-01');assert.ok(run.subtasks[1].finishedAt);
  assert.equal(run.usage.turns,2);
  const memory=state.memories.find(m=>m.automatic&&m.conversationId===conversation.id);
  assert.match(memory.content,/Ana \(persona\) · Hecha/);
  assert.match(memory.content,/Probado en un Pixel/);
  // Revisar de nuevo con lo que la persona entregó: un turno más, otro mensaje de revisión.
  await call('review',{runId:run.id});
  state=await until(s=>['completed','error'].includes(runOf(s).status)&&runOf(s).usage.turns>2);
  run=runOf(state);
  assert.equal(run.status,'completed',run.error);
  assert.equal(run.usage.turns,3);
  assert.equal(run.review.workspace,'project-direct');
  assert.deepEqual(state.messages.filter(m=>m.runId===run.id).map(m=>m.kind||m.role),['manual','work','review','review-request','review']);
  await assert.rejects(call('review',{runId:run.id,model:'--no'}),/Identificador de modelo no válido/);
  await assert.rejects(call('review',{runId:run.id,effort:'ultra-mega'}),/nivel de razonamiento/);
});

test('el arquitecto puede asignar una parte a una persona del equipo, y la tarea la espera',async t=>{
  const {call,work,until,project}=await boot(t,{delay:50,scenario:'equipo'});
  const ana=await call('people',{name:'Ana',role:'QA',notes:'móvil de pruebas',projectId:project.id});
  const conversation=await call('conversations',{projectId:project.id});
  await call('run',{conversationId:conversation.id,prompt:'Saca la versión y pruébala',readOnly:false,
    orchestrator:{provider:'claude',model:'claude-fake',effort:'medium'}});
  let run=runOf(await until(s=>runOf(s).status==='awaiting-plan'));
  assert.equal(run.subtasks.length,2);
  assert.equal(run.subtasks[1].human,true);
  assert.equal(run.subtasks[1].personId,ana.id,'la persona se resolvió por nombre, sin distinguir mayúsculas');
  await call('plan',{runId:run.id,approve:true,subtasks:[]});
  const state=await until(s=>['completed','error'].includes(runOf(s).status));
  run=runOf(state);
  assert.equal(run.status,'completed',run.error);
  assert.equal(run.stage,'Pendiente de 1 persona');
  assert.equal(run.subtasks[0].self,true,'la única sub-tarea de agente la hace el arquitecto en su sesión');
  assert.equal(fs.readFileSync(path.join(work,'uno.txt'),'utf8'),'escrito por la sub-tarea uno.txt\n');
  assert.equal(run.review.status,'integrar');
  assert.equal(run.subtasks[1].status,'pendiente');
});

test('en el plan del arquitecto se puede pasar una sub-tarea a una persona, y de vuelta a un agente',async t=>{
  const {call,work,until,project}=await boot(t,{delay:50});
  const ana=await call('people',{name:'Ana',role:'QA',projectId:project.id});
  const conversation=await call('conversations',{projectId:project.id});
  await call('run',{conversationId:conversation.id,prompt:'Reparte este trabajo',readOnly:false,
    orchestrator:{provider:'claude',model:'claude-fake',effort:'medium'}});
  let run=runOf(await until(s=>runOf(s).status==='awaiting-plan'));
  await call('plan',{runId:run.id,approve:true,subtasks:[
    {id:run.subtasks[1].id,provider:'persona',personId:ana.id},
    {id:run.subtasks[0].id,provider:'persona',personId:'nadie'}]});
  const state=await until(s=>['completed','error'].includes(runOf(s).status));
  run=runOf(state);
  assert.equal(run.status,'completed',run.error);
  assert.equal(run.subtasks[1].human,true);assert.equal(run.subtasks[1].personName,'Ana');
  assert.equal(run.subtasks[0].human,false,'una persona desconocida no se aplica; la sub-tarea sigue con su agente');
  const events=run.events.map(e=>e.text).join('\n');
  assert.match(events,/asignada a Ana \(persona\)/);
  assert.match(events,/no está en el equipo/);
  assert.equal(fs.readFileSync(path.join(work,'uno.txt'),'utf8'),'escrito por la sub-tarea uno.txt\n');
  assert.equal(fs.existsSync(path.join(work,'dos.txt')),false,'la parte de Ana no la ejecuta nadie');
  assert.equal(run.stage,'Pendiente de 1 persona');
  // Una tarea solo de personas no se revisa hasta que ellas terminen.
  await call('run',{conversationId:conversation.id,prompt:'Solo Ana',readOnly:false,mode:'manual',orchestrator:{provider:'claude',model:'claude-fake'},
    plan:{review:true,subtasks:[{title:'Probar',provider:'persona',personId:ana.id,instructions:'Prueba todo'}]}});
  const only=runOf(await until(s=>s.runs.length===2&&['completed','error'].includes(runOf(s).status)));
  assert.equal(only.status,'completed');assert.equal(only.review,null);assert.equal(only.usage,null);
  assert.equal(only.stage,'Pendiente de 1 persona');
});

test('cooperación por git: dos Mixto sobre clones del mismo repositorio comparten equipo y encargos, y un commit da el encargo por hecho',async t=>{
  // Manuel: su Mixto, su clon, su equipo.
  const A=await boot(t,{delay:50,remote:true});
  const ana=await A.call('people',{name:'Ana',role:'QA',email:'ana@example.invalid',projectId:A.project.id});
  await A.call('cooperation',{projectId:A.project.id,enabled:true});
  let stateA=await A.until(s=>s.projects.find(p=>p.id===A.project.id).cooperation.lastPublish?.pushed===true);
  let projectA=stateA.projects.find(p=>p.id===A.project.id);
  assert.equal(projectA.cooperation.enabled,true);
  assert.equal(projectA.cooperation.identity.email,'test@example.invalid');
  assert.equal(projectA.cooperation.identity.personId,null,'Manuel no está en el equipo con ese correo');
  assert.match(git(A.bare,'branch'),/mixto-encargos/);
  assert.equal(git(A.work,'status','--porcelain').trim(),'','la carpeta del proyecto no se toca');
  // Un reparto a mano con una parte para Ana pasa al libro del repositorio.
  const conversation=await A.call('conversations',{projectId:A.project.id});
  await A.call('run',{conversationId:conversation.id,prompt:'Saca la versión',readOnly:false,mode:'manual',orchestrator:{provider:'claude',model:'claude-fake'},
    plan:{review:false,subtasks:[{title:'Probar en móvil',provider:'persona',personId:ana.id,instructions:'Prueba el flujo en un móvil real.',scope:'app/'}]}});
  stateA=await A.until(s=>['completed','error'].includes(runOf(s).status)&&s.projects.find(p=>p.id===A.project.id).assignments.length===1);
  let run=runOf(stateA);
  const subtask=run.subtasks[0];
  assert.equal(subtask.assignmentId,subtask.id);
  for(let attempt=0;attempt<60;attempt++){try{if(git(A.bare,'ls-tree','--name-only','mixto-encargos','encargos/').includes(subtask.id))break;}catch{}await wait(250);}
  assert.match(git(A.bare,'ls-tree','--name-only','mixto-encargos','encargos/'),new RegExp(subtask.id),'el encargo está publicado en el remoto');
  // Ana trabaja en su clon y cita el encargo en un commit.
  const B=await boot(t,{delay:50,cloneOf:A.bare,identity:{name:'Ana',email:'ana@example.invalid'}});
  const short=subtask.id.replace(/-/g,'').slice(0,8);
  fs.writeFileSync(path.join(B.work,'movil.txt'),'probado\n');git(B.work,'add','movil.txt');
  git(B.work,'commit','-q','-m',`test: prueba en móvil\n\nmixto:${short}`);git(B.work,'push','-q','origin','main');
  // Manuel sincroniza: el encargo se da por hecho solo, y su tarea local lo refleja.
  const synced=await A.call('cooperation/sync',{projectId:A.project.id});
  assert.deepEqual(synced.autoDone,[subtask.id]);
  stateA=await A.call('state');run=runOf(stateA);projectA=stateA.projects.find(p=>p.id===A.project.id);
  assert.equal(projectA.assignments[0].status,'hecha');
  assert.match(projectA.assignments[0].notes.at(-1),/hecho en el commit [0-9a-f]{7} de Ana: test: prueba en móvil/);
  assert.equal(run.subtasks[0].status,'hecha');
  assert.equal(run.stage,'Completado');
  assert.match(stateA.memories.find(m=>m.automatic&&m.conversationId===conversation.id).content,/hecho en el commit/);
  // El Mixto de Ana abre el mismo repositorio: importa el equipo, se reconoce por su correo y ve el encargo.
  await B.call('cooperation',{projectId:B.project.id,enabled:true});
  let stateB=await B.until(s=>s.projects.find(p=>p.id===B.project.id).cooperation.identity?.personId===ana.id);
  let projectB=stateB.projects.find(p=>p.id===B.project.id);
  assert.ok(stateB.people.some(p=>p.id===ana.id&&p.name==='Ana'),'la persona llegó con el mismo identificador');
  assert.deepEqual(projectB.members,[ana.id]);
  assert.equal(projectB.assignments.length,1);
  assert.equal(projectB.assignments[0].status,'hecha');
  // Ana reabre el encargo con una nota desde su Mixto; Manuel lo recibe.
  await B.call('assignments/'+subtask.id,{projectId:B.project.id,status:'en-curso',note:'Falta el scroll en Android'},'PATCH');
  stateB=await B.until(s=>s.projects.find(p=>p.id===B.project.id).cooperation.lastPublish?.pushed===true&&s.projects.find(p=>p.id===B.project.id).assignments[0].status==='en-curso');
  await A.call('cooperation/sync',{projectId:A.project.id});
  stateA=await A.call('state');run=runOf(stateA);projectA=stateA.projects.find(p=>p.id===A.project.id);
  assert.equal(projectA.assignments[0].status,'en-curso');
  assert.ok(projectA.assignments[0].notes.some(n=>/Ana: Falta el scroll en Android/.test(n)),JSON.stringify(projectA.assignments[0].notes));
  assert.equal(run.subtasks[0].status,'en-curso');
  assert.equal(run.stage,'Pendiente de 1 persona');
  // Un encargo suelto creado por Manuel aparece en el Mixto de Ana, y el arquitecto de Manuel sabe cuántos tiene pendientes.
  await A.call('assignments',{projectId:A.project.id,personId:ana.id,title:'Revisar textos',instructions:'Repasa los textos de la pantalla de pago.',due:'2026-10-01'});
  stateA=await A.until(s=>s.projects.find(p=>p.id===A.project.id).assignments.length===2&&s.projects.find(p=>p.id===A.project.id).cooperation.lastPublish?.pushed===true);
  await B.call('cooperation/sync',{projectId:B.project.id});
  stateB=await B.call('state');projectB=stateB.projects.find(p=>p.id===B.project.id);
  assert.equal(projectB.assignments.length,2);
  assert.ok(projectB.assignments.some(a=>a.title==='Revisar textos'&&a.due==='2026-10-01'&&a.origin===''));
  assert.equal(git(A.work,'status','--porcelain').trim(),'');
  assert.equal(git(B.work,'status','--porcelain').trim(),'');
  await assert.rejects(A.call('cooperation/sync',{projectId:(await A.call('projects',{name:'Suelto',directoryName:'suelto',description:''})).id}),/no está activada/);
});

test('un comando permitido en el proyecto se aprueba solo, en Claude y en Codex, y «permitir siempre» lo aprende',async t=>{
  const {call,until,project}=await boot(t,{delay:50});
  const conversation=await call('conversations',{projectId:project.id});
  const direct=(provider,prompt)=>call('run',{conversationId:conversation.id,prompt,readOnly:false,mode:'directo',orchestrator:{provider,model:provider==='claude'?'claude-fake':'codex-fake',effort:null}});
  await direct('claude','PERMISSION-CHECK');
  let state=await until(s=>s.approvals.length===1);
  assert.equal(state.approvals[0].command,'echo test');
  await call('approvals/'+state.approvals[0].id,{allow:true,remember:true});
  state=await until(s=>['completed','error'].includes(runOf(s).status));
  assert.equal(runOf(state).subtasks[0].text,'Permitido');
  assert.deepEqual(state.projects.find(p=>p.id===project.id).allowedCommands,['echo test']);
  await direct('codex','PERMISSION-CHECK');
  state=await until(s=>s.runs.length===2&&['completed','error'].includes(runOf(s).status));
  assert.equal(runOf(state).subtasks[0].text,'Permitido','la segunda vez no pregunta, tampoco a Codex');
  assert.equal(state.approvals.length,0);
  assert.match(runOf(state).subtasks.flatMap(s=>s.events).map(e=>e.text).join('\n'),/Comando permitido en el proyecto: echo test/);
  await call('projects/'+project.id+'/settings',{allowedCommands:['npm test','  echo   test ','npm test']});
  assert.deepEqual((await call('state')).projects.find(p=>p.id===project.id).allowedCommands,['npm test','echo test']);
});

test('el visor de cambios muestra el diff del turno y permite deshacerlo, por archivo o entero',async t=>{
  const {call,work,until,project}=await boot(t,{delay:50});
  const conversation=await call('conversations',{projectId:project.id});
  const direct=prompt=>call('run',{conversationId:conversation.id,prompt,readOnly:false,mode:'directo',orchestrator:{provider:'claude',model:'claude-fake',effort:null}});
  await direct('ARCHIVO:nuevo.txt');
  let state=await until(s=>['completed','error'].includes(runOf(s).status));
  let run=runOf(state);
  assert.ok(run.snapshot,'el modo directo con escritura toma una instantánea');
  assert.deepEqual(run.subtasks[0].diff.created,['nuevo.txt']);
  const diff=await call(`diff?runId=${run.id}&subtaskId=${run.subtasks[0].id}`);
  assert.equal(diff.source,'diff');assert.equal(diff.applied,true);assert.equal(diff.pending,false);
  assert.equal(diff.created[0].path,'nuevo.txt');assert.match(diff.created[0].text,/^\+escrito por la sub-tarea nuevo\.txt/);
  assert.equal(diff.summary.files,1);
  await call('revert',{runId:run.id,subtaskId:run.subtasks[0].id,files:[]});
  assert.equal(fs.existsSync(path.join(work,'nuevo.txt')),false,'deshacer el turno elimina el archivo que creó');
  state=await call('state');run=runOf(state);
  assert.equal(run.subtasks[0].reverted,true);
  assert.equal(state.changes[project.id].files,0,'el resumen de cambios sin confirmar se actualiza');
  await assert.rejects(call('revert',{runId:run.id,subtaskId:run.subtasks[0].id,files:[]}),/ya se deshizo/);
  await direct('ARCHIVO:base.txt');
  state=await until(s=>s.runs.length===2&&['completed','error'].includes(runOf(s).status));run=runOf(state);
  assert.equal(fs.readFileSync(path.join(work,'base.txt'),'utf8'),'escrito por la sub-tarea base.txt\n');
  const diff2=await call(`diff?runId=${run.id}&subtaskId=${run.subtasks[0].id}`);
  assert.deepEqual(diff2.files.map(f=>[f.path,f.status,f.additions,f.deletions]),[['base.txt','modified',1,1]]);
  await call('revert',{runId:run.id,subtaskId:run.subtasks[0].id,files:['base.txt']});
  assert.equal(fs.readFileSync(path.join(work,'base.txt'),'utf8'),'base\n','git apply -R devuelve el archivo a como estaba');
  assert.deepEqual(runOf(await call('state')).subtasks[0].revertedFiles,['base.txt']);
});

test('en un parche pendiente se pueden excluir archivos antes de integrar',async t=>{
  const {call,work,until,project}=await boot(t,{delay:50});
  const conversation=await call('conversations',{projectId:project.id});
  await call('run',{conversationId:conversation.id,prompt:'Dos archivos',readOnly:false,mode:'manual',orchestrator:{provider:'codex',model:'codex-fake',effort:null},
    plan:{review:false,subtasks:[{title:'Uno',provider:'claude',model:'claude-fake',instructions:'ARCHIVO:uno.txt'},{title:'Dos',provider:'codex',model:'codex-fake',instructions:'ARCHIVO:dos.txt'}]}});
  const run=runOf(await until(s=>['completed','error'].includes(runOf(s).status)));
  const diff=await call(`diff?runId=${run.id}&subtaskId=${run.subtasks[0].id}`);
  assert.equal(diff.source,'patch');assert.equal(diff.pending,true);
  assert.deepEqual(diff.files.map(f=>[f.path,f.status]),[['uno.txt','added']]);
  await call('revert',{runId:run.id,subtaskId:run.subtasks[0].id,files:['uno.txt'],toggle:true});
  assert.deepEqual(runOf(await call('state')).subtasks[0].patchExcludes,['uno.txt']);
  await call('revert',{runId:run.id,subtaskId:run.subtasks[0].id,files:['uno.txt'],toggle:true});
  assert.deepEqual(runOf(await call('state')).subtasks[0].patchExcludes,[],'volver a incluir');
  await call('revert',{runId:run.id,subtaskId:run.subtasks[0].id,files:['uno.txt'],toggle:true});
  const result=await call('integrate',{runId:run.id});
  assert.equal(result.applied.length,2);
  assert.equal(fs.existsSync(path.join(work,'uno.txt')),false,'el archivo excluido no se integra');
  assert.equal(fs.existsSync(path.join(work,'dos.txt')),true);
});

test('el terminal del proyecto ejecuta comandos, enseña la salida y se puede detener',async t=>{
  const {call,until,project}=await boot(t,{delay:50});
  await call('exec',{projectId:project.id,command:'echo hola-mixto'});
  let state=await until(s=>s.execs[project.id]?.status==='finished');
  assert.match(state.execs[project.id].output,/hola-mixto/);
  assert.equal(state.execs[project.id].code,0);
  await call('exec',{projectId:project.id,command:`"${process.execPath}" -e "setTimeout(()=>{},60000)"`});
  await until(s=>s.execs[project.id]?.status==='running');
  await assert.rejects(call('exec',{projectId:project.id,command:'echo otra'}),/Ya hay un comando/);
  await call('exec/stop',{projectId:project.id});
  state=await until(s=>s.execs[project.id]?.status!=='running');
  assert.equal(state.execs[project.id].status,'stopped');
});

test('confirmar cambios: propuesta de mensaje con un agente, commit de lo elegido y push al remoto',async t=>{
  const {call,work,project,bare}=await boot(t,{delay:50,remote:true});
  fs.writeFileSync(path.join(work,'base.txt'),'cambiado\n');fs.writeFileSync(path.join(work,'extra.txt'),'nuevo\n');
  const changes=await call(`changes?projectId=${project.id}`);
  assert.deepEqual(changes.files.map(f=>[f.path,f.status]).sort(),[['base.txt','modified'],['extra.txt','untracked']]);
  assert.match(changes.diff,/-base\n\+cambiado/);
  assert.equal(changes.parsed[0].path,'base.txt');
  const proposal=await call('commit/propose',{projectId:project.id,provider:'claude',model:'claude-fake',effort:null});
  assert.equal(proposal.message,'Respuesta verificada: áéñ');
  const committed=await call('commit',{projectId:project.id,message:'feat: cambio de prueba',files:['base.txt']});
  assert.match(committed.hash,/^[0-9a-f]{7,}$/);
  assert.match(git(work,'log','-1','--format=%s'),/feat: cambio de prueba/);
  assert.equal(git(work,'status','--porcelain').trim(),'?? extra.txt','solo se confirmó lo elegido');
  const pushed=await call('push',{projectId:project.id});
  assert.equal(pushed.ok,true);
  assert.match(git(bare,'log','-1','--format=%s','main'),/feat: cambio de prueba/);
  await assert.rejects(call('commit',{projectId:project.id,message:'x',files:[]}),/al menos un archivo/);
  assert.equal((await call('state')).changes[project.id].files,1);
});

test('segunda opinión: el otro agente revisa los cambios sin confirmar en solo lectura',async t=>{
  const {call,work,until,project}=await boot(t,{delay:50});
  const conversation=await call('conversations',{projectId:project.id});
  await call('run',{conversationId:conversation.id,prompt:'',mode:'opinion',orchestrator:{provider:'codex',model:'codex-fake'}});
  let state=await until(s=>['completed','error'].includes(runOf(s).status));
  assert.equal(runOf(state).status,'error');assert.match(runOf(state).error,/No hay cambios sin confirmar/);
  fs.writeFileSync(path.join(work,'base.txt'),'cambiado\n');
  await call('run',{conversationId:conversation.id,prompt:'Mira el manejo de errores',mode:'opinion',orchestrator:{provider:'codex',model:'codex-fake'}});
  state=await until(s=>s.runs.length===2&&['completed','error'].includes(runOf(s).status));
  const run=runOf(state);
  assert.equal(run.status,'completed',run.error);assert.equal(run.mode,'opinion');assert.equal(run.readOnly,true);
  assert.match(run.prompt,/Segunda opinión de Codex/);assert.match(run.prompt,/Mira el manejo de errores/);
  assert.deepEqual(state.messages.filter(m=>m.runId===run.id).map(m=>m.kind||m.role),['user','opinion']);
  assert.equal(run.subtasks[0].fixable,false);
  assert.equal(fs.readFileSync(path.join(work,'base.txt'),'utf8'),'cambiado\n','no toca nada');
});

test('redirigir un turno en directo lo detiene y continúa la misma sesión con la nueva indicación',async t=>{
  const {call,until,project}=await boot(t,{delay:50});
  const conversation=await call('conversations',{projectId:project.id});
  await call('run',{conversationId:conversation.id,prompt:'WAIT-FOREVER',readOnly:true,mode:'directo',orchestrator:{provider:'claude',model:'claude-fake'}});
  let state=await until(s=>runOf(s).status==='running');
  const first=runOf(state);
  await call('steer',{runId:first.id,prompt:'Mejor explícame base.txt'});
  state=await until(s=>s.runs.length===2&&['completed','error'].includes(runOf(s).status));
  const stopped=state.runs.find(r=>r.id===first.id),next=runOf(state);
  assert.equal(stopped.status,'cancelled');assert.equal(stopped.stage,'Redirigido');assert.equal(stopped.error,null);
  assert.equal(next.status,'completed',next.error);assert.equal(next.mode,'directo');
  assert.match(next.prompt,/^REDIRECCIÓN/);
  assert.equal(state.messages.find(m=>m.runId===next.id&&m.role==='user').content,'Mejor explícame base.txt','el mensaje visible es el tuyo, sin el prefijo');
  await assert.rejects(call('steer',{runId:next.id,prompt:'x'}),/ya ha terminado/);
});

test('adjuntos: una imagen pegada llega a los dos agentes y queda en la carpeta de datos',async t=>{
  const {call,until,project,dir}=await boot(t,{delay:50});
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64');
  const up=await call('upload',{name:'captura.png',mime:'image/png',data:png.toString('base64')});
  assert.ok(fs.existsSync(path.join(dir,'datos','uploads',`${up.id}-captura.png`)));
  await assert.rejects(call('upload',{name:'x.exe',mime:'application/x-msdownload',data:'AA=='}),/no admitido/);
  const conversation=await call('conversations',{projectId:project.id});
  for(const provider of ['claude','codex']){
    await call('run',{conversationId:conversation.id,prompt:'Qué ves',readOnly:true,mode:'directo',attachments:[up.id],orchestrator:{provider,model:provider==='claude'?'claude-fake':'codex-fake'}});
    const state=await until(s=>['completed','error'].includes(runOf(s).status)&&runOf(s).orchestrator.provider===provider);
    const run=runOf(state);
    assert.equal(run.status,'completed',run.error);
    assert.match(run.subtasks[0].text,/\[imágenes: 1\]/,`${provider} recibió la imagen`);
    assert.deepEqual(state.messages.find(m=>m.runId===run.id&&m.role==='user').attachments.map(a=>a.name),['captura.png']);
  }
});

test('el arquitecto reanuda su sesión en la misma conversación',async t=>{
  const {call,until,project}=await boot(t,{delay:50,scenario:'directa'});
  const conversation=await call('conversations',{projectId:project.id});
  const ask=async n=>{await call('run',{conversationId:conversation.id,prompt:'¿Qué es esto?',readOnly:true,orchestrator:{provider:'claude',model:'claude-fake'}});return runOf(await until(s=>s.runs.length===n&&['completed','error'].includes(runOf(s).status)&&runOf(s).phase==='done'));};
  const first=await ask(1);
  assert.doesNotMatch(first.events.map(e=>e.text).join('\n'),/reanuda su sesión/);
  assert.equal((await call('state')).conversations.find(c=>c.id===conversation.id).sessions['architect:claude'],'native-claude');
  const second=await ask(2);
  assert.match(second.events.map(e=>e.text).join('\n'),/reanuda su sesión/);
});

test('actualización desde la app: comprueba la versión publicada, descarga, sustituye archivos y se reinicia',async t=>{
  // Una instalación aparte, copia de los archivos de trabajo del repositorio, para no tocar los reales.
  const install=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mixto-install-')));
  for(const rel of listFiles(root)){fs.mkdirSync(path.dirname(path.join(install,rel)),{recursive:true});fs.copyFileSync(path.join(root,rel),path.join(install,rel));}
  const current=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
  // La «versión nueva»: la misma instalación con package.json 9.9.9 y un archivo más, envuelta como hace GitHub.
  const files=listFiles(install).map(rel=>({name:'mixto-main/'+rel,data:rel==='package.json'?Buffer.from(fs.readFileSync(path.join(install,rel),'utf8').replace(current,'9.9.9')):fs.readFileSync(path.join(install,rel))}));
  const zip=buildZip([{name:'mixto-main',dir:true},...files,{name:'mixto-main/NUEVO.txt',data:Buffer.from('nuevo\n')}]);
  const github=http.createServer((req,res)=>{
    if(req.url==='/package.json'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({name:'mixto',version:'9.9.9'}));}
    else if(req.url==='/mixto.zip'){res.writeHead(200,{'Content-Type':'application/zip'});res.end(zip);}
    else{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>github.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${github.address().port}/`;
  t.after(()=>{github.close();try{fs.rmSync(install,{recursive:true,force:true});}catch{}});
  const {call,refreshCookie,project,until,origin}=await boot(t,{delay:50,appRoot:install,env:{MIXTO_UPDATE_CHECK:'on',MIXTO_UPDATE_BASE:base,MIXTO_UPDATE_ZIP:base+'mixto.zip'}});
  let state=await call('state');
  assert.equal(state.app.version,current,'la versión sale de package.json');
  assert.equal(state.update.current,current);
  assert.equal(state.update.downloadUrl,base+'mixto.zip');
  const check=await call('update/check',{});
  assert.equal(check.latest,'9.9.9');assert.equal(check.available,true);assert.equal(check.error,null);
  state=await until(s=>s.update.available===true);
  const applied=await call('update/apply',{});
  assert.equal(applied.version,'9.9.9');
  assert.ok(applied.copied>=2,'package.json y el archivo nuevo, al menos');
  assert.equal(fs.readFileSync(path.join(install,'NUEVO.txt'),'utf8'),'nuevo\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(install,'package.json'),'utf8')).version,'9.9.9');
  assert.equal(fs.readFileSync(path.join(install,'.runtime','backup',current,'package.json'),'utf8').includes(current),true,'copia de lo sustituido');
  assert.equal(JSON.parse(fs.readFileSync(path.join(install,'.runtime','instalado.json'),'utf8')).version,'9.9.9');
  assert.equal(fs.readdirSync(path.join(install,'.runtime','updates')).length,0,'la descarga extraída se limpia');
  // El servidor se reinicia solo, en el mismo puerto, ya con la versión nueva y los mismos datos.
  let health=null;
  for(let attempt=0;attempt<150&&health?.version!=='9.9.9';attempt++){await wait(200);try{health=await (await fetch(origin+'/api/health')).json();}catch{}}
  assert.equal(health?.version,'9.9.9','el servidor nuevo responde');
  await assert.rejects(call('state'),/Recarga Mixto/,'la cookie anterior ya no vale: el navegador recarga');
  await refreshCookie();
  const after=await call('state');
  assert.ok(after.projects.find(p=>p.id===project.id),'los datos siguen ahí');
  assert.equal(after.update.current,'9.9.9');
  await call('shutdown',{});
});

test('GitHub: conectar con un token, listar repositorios, clonar uno como proyecto, traer cambios y desconectar',async t=>{
  // GitHub simulado: la API acepta un único token y publica dos repositorios; el clonado va por file:// a un repositorio bare.
  const clones=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mixto-gh-')));
  const bare=path.join(clones,'tester','demo.git');fs.mkdirSync(path.dirname(bare),{recursive:true});
  execFileSync('git',['init','--quiet','--bare','-b','main',bare],{env:GIT_ENV});
  const seed=path.join(clones,'seed');execFileSync('git',['clone','--quiet',bare,seed],{env:GIT_ENV});
  git(seed,'config','user.name','Tester');git(seed,'config','user.email','tester@example.invalid');
  fs.writeFileSync(path.join(seed,'README.md'),'# demo\n');git(seed,'add','README.md');git(seed,'commit','-q','-m','inicial');git(seed,'push','-q','origin','main');
  const api=http.createServer((req,res)=>{
    const ok=req.headers.authorization==='Bearer ghp_test';
    if(!ok){res.writeHead(401);res.end('{}');return;}
    if(req.url==='/user'){res.end(JSON.stringify({login:'tester',name:'Tester',avatar_url:''}));return;}
    if(req.url.startsWith('/user/repos')){res.end(JSON.stringify([{full_name:'tester/demo',name:'demo',owner:{login:'tester'},private:true,description:'Repositorio de prueba',default_branch:'main',pushed_at:'2026-09-01T00:00:00Z',html_url:'https://github.com/tester/demo',language:'JavaScript'},{full_name:'tester/otro',name:'otro',owner:{login:'tester'},private:false,description:null,default_branch:'main',pushed_at:null,html_url:'https://github.com/tester/otro'}]));return;}
    res.writeHead(404);res.end('{}');
  });
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  t.after(()=>{api.close();try{fs.rmSync(clones,{recursive:true,force:true});}catch{}});
  const {call,project,dir,until}=await boot(t,{delay:50,env:{MIXTO_GITHUB_API:`http://127.0.0.1:${api.address().port}`,MIXTO_GITHUB_CLONE_BASE:'file://'+clones}});
  let state=await call('state');
  assert.deepEqual(state.github,{connected:false,web:'https://github.com'});
  await assert.rejects(call('github/connect',{token:'malo'}),/no acepta el token/);
  await assert.rejects(call('github/repos'),/Conecta GitHub/);
  const connected=await call('github/connect',{token:'ghp_test'});
  assert.equal(connected.login,'tester');assert.equal(connected.connected,true);
  state=await call('state');
  assert.equal(state.github.login,'tester');
  assert.equal(JSON.stringify(state).includes('ghp_test'),false,'el token nunca sale al navegador');
  const stored=JSON.parse(fs.readFileSync(path.join(dir,'datos','mixto.json'),'utf8'));
  assert.equal(stored.github.token,'ghp_test','el token se guarda en local');
  const {repos}=await call('github/repos');
  assert.deepEqual(repos.map(r=>[r.fullName,r.private,r.project]),[['tester/demo',true,null],['tester/otro',false,null]]);
  // Git hereda la autorización: el terminal del proyecto (y por tanto los agentes) la ven por entorno.
  await call('exec',{projectId:project.id,command:'git config --get http.https://github.com/.extraheader'});
  state=await until(s=>s.execs[project.id]?.status!=='running');
  assert.equal(state.execs[project.id].output.trim(),'AUTHORIZATION: basic '+Buffer.from('x-access-token:ghp_test').toString('base64'));
  const cloned=await call('github/clone',{fullName:'tester/demo'});
  assert.equal(cloned.name,'demo');assert.equal(cloned.github.fullName,'tester/demo');
  assert.equal(fs.readFileSync(path.join(cloned.path,'README.md'),'utf8'),'# demo\n');
  assert.equal(path.dirname(cloned.path),path.join(dir,'projects'),'se clona en la carpeta de proyectos');
  assert.equal((await call('github/repos')).repos[0].project,cloned.id,'la lista sabe que ya es un proyecto');
  await assert.rejects(call('github/clone',{fullName:'tester/demo'}),/Ya existe la carpeta/);
  await assert.rejects(call('github/clone',{url:'https://github.com/tester/no-existe'}),/No se pudo clonar/);
  await assert.rejects(call('github/clone',{url:'nada'}),/owner\/nombre/);
  // Alguien empuja un cambio al remoto: «traer cambios» lo recoge; el resumen sabe que hay remoto.
  fs.writeFileSync(path.join(seed,'nuevo.txt'),'nuevo\n');git(seed,'add','nuevo.txt');git(seed,'commit','-q','-m','segundo');git(seed,'push','-q','origin','main');
  const pulled=await call('pull',{projectId:cloned.id});
  assert.equal(pulled.ok,true);
  assert.equal(fs.readFileSync(path.join(cloned.path,'nuevo.txt'),'utf8'),'nuevo\n');
  state=await call('state');
  assert.equal(state.changes[cloned.id].remote,true);
  assert.equal(state.changes[project.id].remote,false);
  const off=await call('github/disconnect',{});
  assert.equal(off.connected,false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'datos','mixto.json'),'utf8')).github,null);
  await call('exec',{projectId:project.id,command:'git config --get http.https://github.com/.extraheader; echo fin'});
  state=await until(s=>s.execs[project.id]?.status!=='running'&&s.execs[project.id].command.includes('fin'));
  assert.equal(state.execs[project.id].output.trim(),'fin','sin token, git ya no lleva la cabecera');
});

test('la carpeta de proyectos se crea sola al arrancar, y crear o clonar un proyecto funciona a la primera',async t=>{
  const fresh=path.join(fs.realpathSync(os.tmpdir()),'mixto-root-'+Date.now()+'-'+Math.floor(Math.random()*1e6));
  t.after(()=>{try{fs.rmSync(fresh,{recursive:true,force:true});}catch{}});
  const {call}=await boot(t,{delay:50,noProject:true,env:{MIXTO_PROJECTS_ROOT:fresh}});
  const state=await call('state');
  assert.equal(fs.existsSync(fresh),true,'la carpeta se ha creado');
  assert.deepEqual(state.app.projectsRoot,{path:fresh,available:true});
  const created=await call('projects',{name:'Nuevo',directoryName:'nuevo'});
  assert.equal(path.dirname(created.path),fresh);
});

test('política de revisión por defecto: una sola parte no paga revisión; dos partes sí; «nunca» deja los cambios a la espera',async t=>{
  const {call,until,work}=await boot(t,{delay:50,scenario:'unica',reviewPolicy:'multi'});
  const conversation=await call('conversations',{projectId:(await call('state')).projects[0].id});
  const orchestrate=(prompt,provider='claude')=>call('run',{conversationId:conversation.id,prompt,readOnly:false,orchestrator:{provider,model:provider==='claude'?'claude-fake':'codex-fake',effort:'medium'}});
  await orchestrate('Una sola parte');
  let state=await until(s=>runOf(s).status==='awaiting-plan');
  assert.equal(runOf(state).subtasks.length,1);
  await call('plan',{runId:runOf(state).id,approve:true,subtasks:[]});
  state=await until(s=>['completed','error'].includes(runOf(s).status));
  assert.equal(runOf(state).status,'completed');
  assert.equal(runOf(state).review,null,'sin revisión con una sola parte');
  assert.equal(runOf(state).usage.turns,2,'plan y trabajo: dos turnos, no tres');
  assert.match(runOf(state).events.map(e=>e.text).join('\n'),/Una sola parte: sin revisión automática/);
  assert.equal(fs.existsSync(path.join(work,'solo.txt')),true,'el trabajo está en la carpeta');
  await call('settings',{reviewPolicy:'never'});
  assert.equal((await call('state')).settings.reviewPolicy,'never');
  await call('settings',{reviewPolicy:'rara'});
  assert.equal((await call('state')).settings.reviewPolicy,'multi','un valor desconocido vuelve al predeterminado');
  await call('settings',{balance:'claude'});
  assert.equal((await call('state')).settings.balance,'claude');
});

test('en consulta, Claude Code puede ejecutar un comando si tú lo permites; Codex no escala',async t=>{
  const {call,until,project}=await boot(t,{delay:50});
  const conversation=await call('conversations',{projectId:project.id});
  await call('run',{conversationId:conversation.id,prompt:'PERMISSION-CHECK',readOnly:true,mode:'directo',orchestrator:{provider:'claude',model:'claude-fake'}});
  let state=await until(s=>s.approvals.length===1);
  assert.equal(state.approvals[0].command,'echo test');
  await call('approvals/'+state.approvals[0].id,{allow:false});
  state=await until(s=>['completed','error'].includes(runOf(s).status));
  assert.equal(runOf(state).subtasks[0].text,'Rechazado');
  await call('run',{conversationId:conversation.id,prompt:'PERMISSION-CHECK',readOnly:true,mode:'directo',orchestrator:{provider:'codex',model:'codex-fake'}});
  state=await until(s=>s.runs.length===2&&['completed','error'].includes(runOf(s).status));
  assert.equal(state.approvals.length,0,'Codex en consulta no pregunta');
  assert.equal(runOf(state).subtasks[0].text,'Rechazado');
});

test('la preferencia de reparto y la cuota de Codex llegan al plan',async()=>{
  const {buildPlanPrompt,balanceNote}=await import('../lib/orchestrator.mjs');
  const connections={claude:{connected:true,models:[{id:'claude-fake'}]},codex:{connected:true,models:[{id:'codex-fake'}],limits:{windows:[{usedPercent:81,minutes:300},{usedPercent:20,minutes:10080}]}}};
  const prompt=buildPlanPrompt({request:'x',connections,balance:'claude'});
  assert.match(prompt,/prefiere que el trabajo lo haga Claude Code/);
  assert.match(prompt,/CUOTA DE CODEX USADA: 81 % de 5 h, 20 % de 7 días\. Está cerca del límite/);
  assert.equal(balanceNote('auto',{codex:{limits:null}}),'');
  assert.doesNotMatch(buildPlanPrompt({request:'x',connections:{claude:{connected:true,models:[]}},balance:'auto'}),/PREFERENCIA DE REPARTO/);
});

test('Auto: Mixto elige agente, modelo y nivel en directo y en el reparto a mano, y lo explica; los ajustes de reparto se guardan',async t=>{
  const {call,until,project}=await boot(t,{delay:50});
  const conversation=await call('conversations',{projectId:project.id});
  // Sin tope de Claude, con Codex al 34 %: gana Claude; la petición corta es «pequeña».
  await call('run',{conversationId:conversation.id,prompt:'¿Qué hace base.txt?',readOnly:true,mode:'directo',orchestrator:{provider:'auto'}});
  let state=await until(s=>['completed','error'].includes(runOf(s).status));
  let run=runOf(state);
  assert.equal(run.status,'completed',run.error);
  assert.equal(run.orchestrator.provider,'claude');assert.equal(run.orchestrator.model,'claude-fake');assert.equal(run.orchestrator.auto,true);
  assert.match(run.orchestrator.reason,/^Auto: Claude Code · claude-fake.*tarea pequeña; Codex con ~66 % de cuota/);
  assert.match(run.events.map(e=>e.text).join('\n'),/^Auto: Claude Code/m);
  assert.ok(state.quota.claude.tokens5h>=150,'el consumo de Claude se acumula: '+state.quota.claude.tokens5h);
  // Con un tope orientativo ya superado, Auto pasa a Codex aunque se prefiera Claude.
  await call('settings',{claudeSoftLimit:100,balance:'claude',modelNotes:'Codex para tests.'});
  state=await call('state');
  assert.equal(state.settings.claudeSoftLimit,100);assert.equal(state.settings.modelNotes,'Codex para tests.');
  await call('run',{conversationId:conversation.id,prompt:'Arregla el bug del login',readOnly:true,mode:'directo',orchestrator:{provider:'auto'}});
  state=await until(s=>s.runs.length===2&&['completed','error'].includes(runOf(s).status));
  run=runOf(state);
  assert.equal(run.orchestrator.provider,'codex');assert.match(run.orchestrator.reason,/Claude Code casi sin cuota/);
  // Reparto a mano con una parte en Auto: se resuelve al enviar con sus propias instrucciones.
  await call('settings',{claudeSoftLimit:0,balance:'auto'});
  await call('run',{conversationId:conversation.id,prompt:'Dos partes',readOnly:false,mode:'manual',orchestrator:{provider:'auto'},
    plan:{review:false,subtasks:[{title:'Parte auto',provider:'auto',instructions:'ARCHIVO:auto.txt'},{title:'Parte fija',provider:'codex',model:'codex-fake',instructions:'ARCHIVO:fija.txt'}]}});
  state=await until(s=>s.runs.length===3&&['completed','error'].includes(runOf(s).status));
  run=runOf(state);
  assert.equal(run.status,'completed',run.error);
  assert.equal(run.subtasks[0].provider,'claude');assert.equal(run.subtasks[0].auto,true);assert.equal(run.subtasks[0].magnitude,'pequeña');
  assert.equal(run.subtasks[1].provider,'codex');assert.equal(run.subtasks[1].auto,undefined);
  assert.match(run.events.map(e=>e.text).join('\n'),/#1 Parte auto: Auto: Claude Code/);
  await call('settings',{claudeSoftLimit:-5});
  assert.equal((await call('state')).settings.claudeSoftLimit,0,'un tope negativo se descarta');
});
