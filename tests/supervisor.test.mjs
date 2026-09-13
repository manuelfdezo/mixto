import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {matchesScope,detect,Watcher} from '../lib/supervisor.mjs';

const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{windowsHide:true,encoding:'utf8'});

test('matchesScope: un alcance vacío nunca limita',()=>{
  assert.equal(matchesScope('cualquier/archivo.js',[]),true);
  assert.equal(matchesScope('cualquier/archivo.js',undefined),true);
});

test('matchesScope: rutas planas, con mayúsculas y con backslash de Windows',()=>{
  assert.equal(matchesScope('src/uno.txt',['src/uno.txt']),true);
  assert.equal(matchesScope('SRC/UNO.TXT',['src/uno.txt']),true);
  assert.equal(matchesScope('src\\uno.txt',['src/uno.txt']),true);
  assert.equal(matchesScope('src/dos.txt',['src/uno.txt']),false);
  assert.equal(matchesScope('src/sub/uno.txt',['src']),true,'una ruta declarada como carpeta cubre su contenido');
  assert.equal(matchesScope('otro/uno.txt',['src']),false);
});

test('matchesScope: comodín simple limitado a un nivel',()=>{
  assert.equal(matchesScope('src/uno.js',['src/*.js']),true);
  assert.equal(matchesScope('src/sub/uno.js',['src/*.js']),false,'* no cruza carpetas');
});

test('matchesScope: doble comodín cruza cualquier profundidad',()=>{
  assert.equal(matchesScope('src/a/b/uno.test.js',['**/*.test.js']),true);
  assert.equal(matchesScope('uno.test.js',['**/*.test.js']),true);
  assert.equal(matchesScope('src/uno.js',['**/*.test.js']),false);
  assert.equal(matchesScope('src/a/b/util.js',['src/**/util.js']),true);
});

test('detect: no informa de nada cuando cada sub-tarea toca lo suyo',()=>{
  const events=detect([
    {index:0,scope:['uno.txt'],files:['uno.txt']},
    {index:1,scope:['dos.txt'],files:['dos.txt']}
  ]);
  assert.deepEqual(events,[]);
});

test('detect: colisión cuando dos sub-tareas tocan el mismo archivo',()=>{
  const events=detect([
    {index:0,scope:[],files:['compartido.txt']},
    {index:1,scope:[],files:['compartido.txt']}
  ]);
  assert.deepEqual(events,[{type:'colision',file:'compartido.txt',indexes:[0,1]}]);
});

test('detect: invasión cuando una sub-tarea sale de su alcance declarado',()=>{
  const events=detect([
    {index:0,scope:['uno.txt'],files:['uno.txt','fuera.txt']}
  ]);
  assert.deepEqual(events,[{type:'invasion',index:0,file:'fuera.txt'}]);
});

test('detect: ordena de forma determinista por archivo y luego por índice, y no duplica',()=>{
  const events=detect([
    {index:2,scope:[],files:['zeta.txt','alfa.txt']},
    {index:1,scope:[],files:['alfa.txt']},
    {index:0,scope:['beta.txt'],files:['beta.txt','fuera.txt']}
  ]);
  const files=events.map(e=>e.file);
  assert.deepEqual(files,[...files].sort());
  assert.equal(events.filter(e=>e.file==='alfa.txt').length,1);
});

function watcherRepo(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mixto-supervisor-')));
  const roots=new Map();
  for(const index of [0,1]){
    const root=path.join(dir,String(index));
    fs.mkdirSync(root);
    git(root,'init','-b','main');
    git(root,'config','user.name','Mixto Test');
    git(root,'config','user.email','test@example.invalid');
    fs.writeFileSync(path.join(root,'base.txt'),'base\n');
    git(root,'add','base.txt');git(root,'commit','-m','inicial');
    roots.set(index,root);
  }
  t.after(()=>{try{fs.rmSync(dir,{recursive:true,force:true});}catch{}});
  return roots;
}

test('Watcher: informa un evento una sola vez aunque el sondeo se repita',async t=>{
  const roots=watcherRepo(t);
  const subtasks=[{index:0,scope:[]},{index:1,scope:[]}];
  fs.writeFileSync(path.join(roots.get(0),'compartido.txt'),'uno\n');
  fs.writeFileSync(path.join(roots.get(1),'compartido.txt'),'dos\n');
  const seen=[];
  const watcher=new Watcher({roots,subtasks,intervalMs:50,onEvents:events=>seen.push(...events)});
  await watcher.poll();
  await watcher.poll();
  watcher.stop();
  assert.equal(seen.length,1);
  assert.equal(seen[0].type,'colision');
  assert.equal(seen[0].file,'compartido.txt');
});

test('Watcher: un nuevo evento distinto sí se informa en un sondeo posterior',async t=>{
  const roots=watcherRepo(t);
  const subtasks=[{index:0,scope:['uno.txt']},{index:1,scope:[]}];
  const watcher=new Watcher({roots,subtasks,intervalMs:50,onEvents:events=>{}});
  await watcher.poll();
  const collected=[];
  watcher.onEvents=events=>collected.push(...events);
  fs.writeFileSync(path.join(roots.get(0),'fuera.txt'),'x\n');
  await watcher.poll();
  watcher.stop();
  assert.deepEqual(collected,[{type:'invasion',index:0,file:'fuera.txt'}]);
});

test('Watcher: cambios de ruido en .atl en varias copias no generan ningún evento',async t=>{
  const roots=watcherRepo(t);
  for(const index of [0,1]){
    const root=roots.get(index);
    fs.mkdirSync(path.join(root,'.atl'),{recursive:true});
    fs.writeFileSync(path.join(root,'.atl','.skill-registry.cache.json'),'{}');
    fs.writeFileSync(path.join(root,'.atl','skill-registry.md'),'# registro\n');
  }
  const subtasks=[{index:0,scope:[]},{index:1,scope:[]}];
  const events=[];
  const watcher=new Watcher({roots,subtasks,intervalMs:50,onEvents:e=>events.push(...e)});
  await watcher.poll();
  watcher.stop();
  assert.deepEqual(events,[]);
});

test('Watcher: un fallo de git en una copia no interrumpe el sondeo de las demás',async t=>{
  const roots=watcherRepo(t);
  roots.set(2,path.join(fs.realpathSync(os.tmpdir()),'mixto-supervisor-carpeta-inexistente-'+Date.now()));
  const subtasks=[{index:0,scope:[]},{index:1,scope:[]},{index:2,scope:[]}];
  fs.writeFileSync(path.join(roots.get(0),'compartido.txt'),'uno\n');
  fs.writeFileSync(path.join(roots.get(1),'compartido.txt'),'dos\n');
  const events=[];
  const watcher=new Watcher({roots,subtasks,intervalMs:50,onEvents:e=>events.push(...e)});
  await assert.doesNotReject(watcher.poll());
  watcher.stop();
  assert.equal(events.length,1);
  assert.equal(events[0].type,'colision');
});
