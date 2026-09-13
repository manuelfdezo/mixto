import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.dirname(here);
const agent=path.join(here,'fake-agent.mjs');
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{windowsHide:true,encoding:'utf8'});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function boot(t,{delay=600,scenario}={}) {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mixto-orq-')));
  const projectsRoot=path.join(dir,'projects');fs.mkdirSync(projectsRoot);
  const work=path.join(projectsRoot,'proyecto');fs.mkdirSync(work);
  git(work,'init','-b','main');
  git(work,'config','user.name','Mixto Test');
  git(work,'config','user.email','test@example.invalid');
  git(work,'config','core.autocrlf','false');
  fs.writeFileSync(path.join(work,'base.txt'),'base\n');
  git(work,'add','base.txt');git(work,'commit','-m','inicial');
  const port=20000+Math.floor(Math.random()*20000);
  const child=spawn(process.execPath,['server.mjs'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],
    env:{...process.env,MIXTO_PORT:String(port),MIXTO_DATA_DIR:path.join(dir,'datos'),
      MIXTO_PROJECTS_ROOT:projectsRoot,
      ENGRAM_DATA_DIR:path.join(dir,'engram'),FAKE_AGENT_DELAY:String(delay),MIXTO_MAX_PARALLEL:'3',
      ...(scenario?{FAKE_AGENT_SCENARIO:scenario}:{}),
      // Esta prueba es del motor de orquestación: no debe tocar la memoria compartida real.
      MIXTO_ENGRAM_PATH:path.join(dir,'sin-engram.exe'),
      MIXTO_CODEX_PATH:JSON.stringify([process.execPath,agent,'codex']),
      MIXTO_CLAUDE_PATH:JSON.stringify([process.execPath,agent,'claude'])}});
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
  const project=await call('projects',{name:'Proyecto de prueba',path:work,description:''});
  return {call,work,dir,project,log:()=>log,
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
