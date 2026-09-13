import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {inspect,initRepository,createWorkspaces,capturePatch,checkPatches,applyPatches,removeWorkspaces,cleanupOrphanWorkspaces,ignoredPaths,isIgnored} from '../lib/isolation.mjs';

const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{windowsHide:true,encoding:'utf8'});
const read=file=>fs.readFileSync(file,'utf8');

function repo(t) {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mixto-iso-')));
  const data=path.join(dir,'data');fs.mkdirSync(data);
  const work=path.join(dir,'work');fs.mkdirSync(work);
  git(work,'init','-b','main');
  git(work,'config','user.name','Mixto Test');
  git(work,'config','user.email','test@example.invalid');
  // Fija los finales de línea para que las aserciones comparen contenido, no la política de git en Windows.
  git(work,'config','core.autocrlf','false');
  fs.writeFileSync(path.join(work,'a.txt'),'uno\n');
  fs.writeFileSync(path.join(work,'b.txt'),'dos\n');
  git(work,'add','a.txt','b.txt');
  git(work,'commit','-m','inicial');
  t.after(()=>{try{fs.rmSync(dir,{recursive:true,force:true});}catch{}});
  return {dir,work,data};
}

test('inspect distingue una carpeta sin git de un repositorio',t=>{
  const {work,dir}=repo(t);
  const plain=path.join(dir,'suelta');fs.mkdirSync(plain);
  assert.equal(inspect(plain).kind,'shared');
  const found=inspect(work);
  assert.equal(found.kind,'worktree');
  assert.equal(fs.realpathSync(found.toplevel),work);
  assert.equal(found.relative,'');
  assert.ok(found.head);
});

test('inspect reporta el trabajo sin guardar y la subcarpeta del proyecto',t=>{
  const {work}=repo(t);
  fs.writeFileSync(path.join(work,'a.txt'),'uno cambiado\n');
  fs.writeFileSync(path.join(work,'nuevo.txt'),'sin seguimiento\n');
  const sub=path.join(work,'paquete');fs.mkdirSync(sub);
  const found=inspect(sub);
  assert.equal(found.kind,'worktree');
  assert.equal(found.relative,'paquete');
  assert.deepEqual(found.dirtyTracked,['a.txt']);
  assert.deepEqual(found.untracked,['nuevo.txt']);
});

test('createWorkspaces aísla las sub-tareas e incluye el trabajo sin guardar',async t=>{
  const {work,data}=repo(t);
  fs.writeFileSync(path.join(work,'a.txt'),'uno sin guardar\n');
  fs.writeFileSync(path.join(work,'nuevo.txt'),'sin seguimiento\n');
  const spaces=await createWorkspaces({projectPath:work,dataDir:data,runId:'run-1234',indexes:[0,1]});
  const uno=spaces.cwds.get(0),dos=spaces.cwds.get(1);
  // Cada sub-tarea ve el estado real del proyecto, incluido lo no guardado y lo no seguido.
  assert.equal(read(path.join(uno,'a.txt')),'uno sin guardar\n');
  assert.equal(read(path.join(uno,'nuevo.txt')),'sin seguimiento\n');
  // Y lo que escribe una no lo ve la otra ni el proyecto original.
  fs.writeFileSync(path.join(uno,'a.txt'),'escrito por la sub-tarea 0\n');
  assert.equal(read(path.join(dos,'a.txt')),'uno sin guardar\n');
  assert.equal(read(path.join(work,'a.txt')),'uno sin guardar\n');
  await removeWorkspaces({projectPath:work,dataDir:data,runId:'run-1234'});
  assert.doesNotMatch(git(work,'worktree','list'),/run-1234/);
});

test('capturePatch y applyPatches llevan el trabajo de vuelta al proyecto sin crear commits',async t=>{
  const {work,data}=repo(t);
  const head=git(work,'rev-parse','HEAD').trim();
  const spaces=await createWorkspaces({projectPath:work,dataDir:data,runId:'run-apply',indexes:[0,1]});
  fs.writeFileSync(path.join(spaces.cwds.get(0),'a.txt'),'tocado por 0\n');
  fs.writeFileSync(path.join(spaces.cwds.get(1),'c.txt'),'creado por 1\n');
  const patches=[];
  for(const index of [0,1]) {
    const patch=await capturePatch({worktreeRoot:spaces.roots.get(index),patchPath:path.join(data,`${index}.patch`)});
    assert.ok(patch,'cada sub-tarea con cambios produce un parche');
    patches.push(patch);
  }
  assert.equal(patches[0].files,1);
  assert.ok(patches[1].insertions>=1);
  assert.deepEqual((await checkPatches({projectPath:work,patches})).failures,[]);
  const result=await applyPatches({projectPath:work,patches});
  assert.equal(result.conflicts.length,0);
  assert.equal(read(path.join(work,'a.txt')),'tocado por 0\n');
  assert.equal(read(path.join(work,'c.txt')),'creado por 1\n');
  // El historial del usuario queda intacto: ni commits ni ramas nuevas.
  assert.equal(git(work,'rev-parse','HEAD').trim(),head);
  assert.equal(git(work,'log','--oneline').trim().split('\n').length,1);
  await removeWorkspaces({projectPath:work,dataDir:data,runId:'run-apply'});
});

test('applyPatches no aplica nada cuando dos sub-tareas chocan en el mismo archivo',async t=>{
  const {work,data}=repo(t);
  const spaces=await createWorkspaces({projectPath:work,dataDir:data,runId:'run-clash',indexes:[0,1]});
  fs.writeFileSync(path.join(spaces.cwds.get(0),'a.txt'),'version de 0\n');
  fs.writeFileSync(path.join(spaces.cwds.get(1),'a.txt'),'version de 1\n');
  const patches=[];
  for(const index of [0,1])patches.push(await capturePatch({worktreeRoot:spaces.roots.get(index),patchPath:path.join(data,`clash-${index}.patch`)}));
  const result=await applyPatches({projectPath:work,patches});
  assert.ok(result.conflicts.length>0,'el choque se reporta');
  assert.equal(result.applied.length,0,'no se aplica ninguno de los dos');
  assert.equal(read(path.join(work,'a.txt')),'uno\n','el proyecto queda como estaba');
  await removeWorkspaces({projectPath:work,dataDir:data,runId:'run-clash'});
});

test('capturePatch devuelve null si la sub-tarea no cambió nada',async t=>{
  const {work,data}=repo(t);
  const spaces=await createWorkspaces({projectPath:work,dataDir:data,runId:'run-vacio',indexes:[0]});
  assert.equal(await capturePatch({worktreeRoot:spaces.roots.get(0),patchPath:path.join(data,'vacio.patch')}),null);
  await removeWorkspaces({projectPath:work,dataDir:data,runId:'run-vacio'});
});

test('cleanupOrphanWorkspaces limpia copias que quedaron de un cierre forzado',async t=>{
  const {work,data}=repo(t);
  await createWorkspaces({projectPath:work,dataDir:data,runId:'run-huerfano',indexes:[0]});
  assert.match(git(work,'worktree','list'),/run-huerfano/);
  await cleanupOrphanWorkspaces({dataDir:data,projectPaths:[work]});
  assert.doesNotMatch(git(work,'worktree','list'),/run-huerfano/);
  assert.equal(fs.existsSync(path.join(data,'wt')),false);
});

test('initRepository inicializa una carpeta vacía y deja un HEAD resoluble',async t=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mixto-iso-vacia-')));
  t.after(()=>{try{fs.rmSync(dir,{recursive:true,force:true});}catch{}});
  await initRepository(dir);
  assert.equal(inspect(dir).kind,'worktree');
  assert.doesNotThrow(()=>git(dir,'rev-parse','HEAD'));
});

test('isIgnored: reconoce .atl, su contenido, mayúsculas y backslash de Windows',()=>{
  assert.equal(isIgnored('.atl'),true);
  assert.equal(isIgnored('.atl/skill-registry.md'),true);
  assert.equal(isIgnored('.atl/sub/cache.json'),true);
  assert.equal(isIgnored('.ATL/Cache.JSON'),true);
  assert.equal(isIgnored('.atl\\skill-registry.md'),true);
  assert.equal(isIgnored('real.txt'),false);
  assert.equal(isIgnored('src/.atlantico/archivo.js'),false,'un prefijo parecido no cuenta como .atl');
});

test('isIgnored: MIXTO_PATCH_EXCLUDE suma rutas adicionales separadas por comas',()=>{
  const previous=process.env.MIXTO_PATCH_EXCLUDE;
  process.env.MIXTO_PATCH_EXCLUDE='.cache, tmp/scratch ,,';
  try {
    assert.deepEqual(ignoredPaths(),['.atl','.cache','tmp/scratch']);
    assert.equal(isIgnored('.cache/archivo.json'),true);
    assert.equal(isIgnored('tmp/scratch/x.txt'),true);
    assert.equal(isIgnored('.atl/x.txt'),true,'la lista por defecto se conserva');
  } finally {
    if(previous===undefined)delete process.env.MIXTO_PATCH_EXCLUDE;
    else process.env.MIXTO_PATCH_EXCLUDE=previous;
  }
});

test('capturePatch excluye el ruido de .atl y conserva solo el trabajo real',async t=>{
  const {work,data}=repo(t);
  const spaces=await createWorkspaces({projectPath:work,dataDir:data,runId:'run-atl-mixto',indexes:[0]});
  const root=spaces.cwds.get(0);
  fs.mkdirSync(path.join(root,'.atl'),{recursive:true});
  fs.writeFileSync(path.join(root,'.atl','.skill-registry.cache.json'),'{}');
  fs.writeFileSync(path.join(root,'.atl','skill-registry.md'),'# registro\n');
  fs.writeFileSync(path.join(root,'real.txt'),'trabajo real\n');
  const patch=await capturePatch({worktreeRoot:spaces.roots.get(0),patchPath:path.join(data,'atl-mixto.patch')});
  assert.ok(patch,'hay trabajo real, así que se captura un parche');
  assert.equal(patch.files,1);
  const content=read(patch.file);
  assert.match(content,/real\.txt/);
  assert.doesNotMatch(content,/\.atl/);
  await removeWorkspaces({projectPath:work,dataDir:data,runId:'run-atl-mixto'});
});

test('capturePatch devuelve null cuando lo único que cambió es ruido de .atl',async t=>{
  const {work,data}=repo(t);
  const spaces=await createWorkspaces({projectPath:work,dataDir:data,runId:'run-atl-solo',indexes:[0]});
  const root=spaces.cwds.get(0);
  fs.mkdirSync(path.join(root,'.atl'),{recursive:true});
  fs.writeFileSync(path.join(root,'.atl','.skill-registry.cache.json'),'{}');
  assert.equal(await capturePatch({worktreeRoot:spaces.roots.get(0),patchPath:path.join(data,'atl-solo.patch')}),null);
  await removeWorkspaces({projectPath:work,dataDir:data,runId:'run-atl-solo'});
});
