import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {repoState,fetchRemote,listBranches,switchBranch,pullFastForward,pushBranchUpstream,remoteFullName,repoNote} from '../lib/repo.mjs';

const ENV={...process.env,GIT_TERMINAL_PROMPT:'0'};
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',env:ENV});
const write=(dir,name,text)=>fs.writeFileSync(path.join(dir,name),text);

function world(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mixto-repo-')));
  t.after(()=>{try{fs.rmSync(dir,{recursive:true,force:true});}catch{}});
  const bare=path.join(dir,'origen.git');
  execFileSync('git',['init','--quiet','--bare','-b','main',bare],{env:ENV});
  const otro=path.join(dir,'otro');
  execFileSync('git',['clone','--quiet',bare,otro],{env:ENV});
  git(otro,'config','user.name','Otra Persona');git(otro,'config','user.email','otra@example.invalid');
  write(otro,'README.md','# demo\n');git(otro,'add','.');git(otro,'commit','-q','-m','inicial');git(otro,'push','-q','origin','main');
  const mio=path.join(dir,'mio');
  execFileSync('git',['clone','--quiet',bare,mio],{env:ENV});
  git(mio,'config','user.name','Yo');git(mio,'config','user.email','yo@example.invalid');
  return {dir,bare,otro,mio};
}

test('el estado del repositorio dice rama, remoto, último commit y árbol limpio',async t=>{
  const {mio,bare}=world(t);
  const state=await repoState(mio);
  assert.equal(state.git,true);assert.equal(state.empty,false);
  assert.equal(state.branch,'main');assert.equal(state.upstream,'origin/main');
  assert.equal(state.ahead,0);assert.equal(state.behind,0);assert.equal(state.dirty,0);
  assert.equal(state.head.subject,'inicial');assert.equal(state.head.author,'Otra Persona');
  assert.equal(state.remote,'origin');
  assert.equal(await remoteFullName(mio),null,'un remoto local no es un repositorio de GitHub');
  // Con el remoto apuntando a GitHub, el nombre completo se reconoce.
  git(mio,'remote','set-url','origin','https://github.com/manuelfdezo/mixto.git');
  assert.equal((await repoState(mio)).fullName,'manuelfdezo/mixto');
  git(mio,'remote','set-url','origin',bare);
});

test('lo que otra persona empuja a GitHub se ve tras traerlo, y se incorpora con un avance directo',async t=>{
  const {otro,mio}=world(t);
  write(otro,'nuevo.txt','de otra persona\n');git(otro,'add','.');git(otro,'commit','-q','-m','trabajo de otra persona');git(otro,'push','-q','origin','main');
  let state=await repoState(mio);
  assert.equal(state.behind,0,'sin traer, el clon no sabe nada');
  assert.equal((await fetchRemote(mio)).ok,true);
  state=await repoState(mio);
  assert.equal(state.behind,1);
  assert.deepEqual(state.incoming.map(c=>[c.subject,c.author]),[['trabajo de otra persona','Otra Persona']]);
  assert.match(repoNote(state,{pulls:[{number:3,title:'Algo',head:'x',base:'main'}]}),/Te faltan 1 commit\(s\) del remoto: trabajo de otra persona/);
  assert.match(repoNote(state),/El árbol de trabajo está limpio/);
  const pulled=await pullFastForward(mio);
  assert.equal(pulled.ok,true,pulled.error);
  assert.equal(fs.readFileSync(path.join(mio,'nuevo.txt'),'utf8'),'de otra persona\n');
  assert.equal((await repoState(mio)).behind,0);
});

test('los cambios propios cuentan como pendientes de enviar y el push los sube',async t=>{
  const {mio,otro}=world(t);
  write(mio,'mio.txt','mío\n');git(mio,'add','.');git(mio,'commit','-q','-m','mi trabajo');
  let state=await repoState(mio);
  assert.equal(state.ahead,1);assert.equal(state.behind,0);
  assert.match(repoNote(state),/Tienes 1 commit\(s\) sin enviar/);
  const pushed=await pushBranchUpstream(mio);
  assert.equal(pushed.ok,true,pushed.error);
  assert.equal((await repoState(mio)).ahead,0);
  await fetchRemote(otro);
  assert.match(await new Promise(r=>r(git(otro,'log','origin/main','-1','--pretty=%s'))),/mi trabajo/);
  // Un archivo sin confirmar se cuenta aparte.
  write(mio,'borrador.txt','a medias\n');
  state=await repoState(mio);
  assert.equal(state.dirty,1);
  assert.match(repoNote(state),/1 archivo\(s\) con cambios sin confirmar/);
});

test('las ramas se listan y se cambian solo con el árbol limpio',async t=>{
  const {mio,otro}=world(t);
  git(otro,'switch','--quiet','--create','experimento');
  write(otro,'exp.txt','x\n');git(otro,'add','.');git(otro,'commit','-q','-m','experimento');git(otro,'push','-q','origin','experimento');
  await fetchRemote(mio);
  let branches=await listBranches(mio);
  assert.equal(branches.current,'main');
  assert.deepEqual(branches.local,['main']);
  assert.ok(branches.remote.includes('experimento'),'la rama del remoto aparece: '+branches.remote.join(','));
  // Con cambios sin confirmar no se cambia de rama.
  write(mio,'sucio.txt','x\n');git(mio,'add','sucio.txt');
  const blocked=await switchBranch(mio,'experimento');
  assert.equal(blocked.ok,false);assert.match(blocked.error,/cambios sin confirmar/);
  git(mio,'reset','--quiet','--hard');fs.rmSync(path.join(mio,'sucio.txt'),{force:true});
  const moved=await switchBranch(mio,'experimento');
  assert.equal(moved.ok,true,moved.error);
  assert.equal((await repoState(mio)).branch,'experimento');
  assert.equal(fs.existsSync(path.join(mio,'exp.txt')),true);
  const created=await switchBranch(mio,'mi-rama',{create:true});
  assert.equal(created.ok,true,created.error);
  assert.equal((await repoState(mio)).branch,'mi-rama');
  assert.equal((await switchBranch(mio,'--peligrosa')).ok,false,'un nombre con guion inicial se rechaza');
  assert.equal((await switchBranch(mio,'a b c')).ok,false);
});

test('una carpeta sin git, o un repositorio sin commits, lo dicen sin romperse',async t=>{
  const {dir}=world(t);
  const plain=path.join(dir,'sin-git');fs.mkdirSync(plain);
  assert.equal((await repoState(plain)).git,false);
  assert.equal(repoNote(await repoState(plain)),'');
  const empty=path.join(dir,'vacio');fs.mkdirSync(empty);execFileSync('git',['init','--quiet','-b','main',empty],{env:ENV});
  const state=await repoState(empty);
  assert.equal(state.git,true);assert.equal(state.empty,true);
  assert.match(repoNote(state),/todavía sin commits/);
  assert.deepEqual(await listBranches(plain),{local:[],remote:[],current:null});
  assert.equal((await pullFastForward(plain)).ok,false);
});
