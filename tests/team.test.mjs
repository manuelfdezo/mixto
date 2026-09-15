import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {serializeAssignment,parseAssignment,mergeAssignments,serializeRoster,parseRoster,openLedger,readLedger,writeLedger,syncLedger,publishLedger,commitsCiting,shortId,LEDGER_BRANCH} from '../lib/team.mjs';

const ENV={...process.env,GIT_TERMINAL_PROMPT:'0'};
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{windowsHide:true,encoding:'utf8',env:ENV});
const sample={id:'11111111-2222-3333-4444-555555555555',project:'Tienda',title:'Probar el pago',personId:'p-ana',personName:'Ana',personEmail:'ana@example.invalid',
  status:'pendiente',due:'2026-10-01',createdBy:'Manuel <m@example.invalid>',createdAt:'2026-09-14T10:00:00.000Z',updatedAt:'2026-09-14T10:00:00.000Z',
  task:'Saca la versión',origin:'run-1/sub-2',instructions:'Rol: QA\n\nPrueba el flujo de pago con tarjeta.\n\n## Encargo dentro del texto\nno rompe nada',
  scope:['app/pago','docs/'],context:'Usa el entorno de pruebas.',notes:['2026-09-14 · Manuel: creado']};

test('un encargo sobrevive al viaje de ida y vuelta por markdown, también editado a mano con CRLF',()=>{
  const text=serializeAssignment(sample);
  assert.match(text,/^---\nid: 11111111/);
  assert.match(text,/mixto:11111111/,'el archivo explica cómo darlo por hecho desde un commit');
  const back=parseAssignment(text);
  for(const key of ['id','project','title','personId','personName','personEmail','status','due','createdBy','createdAt','updatedAt','task','origin','instructions','context'])assert.equal(back[key],sample[key],key);
  assert.deepEqual(back.scope,sample.scope);
  assert.deepEqual(back.notes,sample.notes);
  assert.deepEqual(back.commits,[]);
  assert.deepEqual(parseAssignment(serializeAssignment({...sample,commits:['abc1234','def5678']})).commits,['abc1234','def5678']);
  const edited=text.replace('estado: pendiente','estado: hecha').replace(/\n$/,'')+'\n- 2026-09-15 · Ana: probado en el Pixel\n';
  const parsed=parseAssignment(edited.replace(/\n/g,'\r\n'));
  assert.equal(parsed.status,'hecha');
  assert.deepEqual(parsed.notes,['2026-09-14 · Manuel: creado','2026-09-15 · Ana: probado en el Pixel']);
  assert.equal(parseAssignment('sin cabecera'),null);
  assert.equal(parseAssignment('---\nestado: hecha\n---\n'),null,'sin id ni título no es un encargo');
  assert.equal(parseAssignment(text.replace('estado: pendiente','estado: inventado')).status,'pendiente','un estado desconocido vuelve a pendiente');
});

test('al mezclar versiones manda la más reciente y las notas se unen; el equipo va y vuelve por JSON',()=>{
  const local={...sample,notes:['a']};
  const remote={...sample,status:'en-curso',updatedAt:'2026-09-15T00:00:00.000Z',notes:['a','b'],scope:['otro/']};
  const merged=mergeAssignments([local,remote]);
  assert.equal(merged.status,'en-curso');
  assert.deepEqual(merged.notes,['a','b']);
  assert.deepEqual(merged.scope,['otro/']);
  assert.deepEqual(mergeAssignments([local,{...local,notes:['c']}]).notes,['a','c'],'a igual fecha, las notas se unen');
  assert.equal(mergeAssignments([]),null);
  const people=[{id:'p1',name:'Ana',role:'QA',email:'ana@example.invalid',notes:'móvil'},{id:'p2',name:'Luis'}];
  assert.deepEqual(parseRoster(serializeRoster(people)),[{id:'p1',name:'Ana',role:'QA',email:'ana@example.invalid',notes:'móvil'},{id:'p2',name:'Luis',role:'',email:'',notes:''}]);
  assert.deepEqual(parseRoster('{roto'),[]);
  assert.equal(shortId(sample.id),'11111111');
});

function repoWithRemote(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mixto-coop-')));
  const bare=path.join(dir,'remote.git');
  execFileSync('git',['init','--bare','-b','main',bare],{env:ENV});
  const clone=(name,who)=>{
    const work=path.join(dir,name);
    execFileSync('git',['clone','--quiet',bare,work],{env:ENV});
    git(work,'config','user.name',who.name);git(work,'config','user.email',who.email);git(work,'config','core.autocrlf','false');
    return work;
  };
  const a=clone('a',{name:'Manuel',email:'m@example.invalid'});
  fs.writeFileSync(path.join(a,'base.txt'),'base\n');git(a,'add','base.txt');git(a,'commit','-q','-m','inicial');git(a,'push','-q','-u','origin','main');
  const b=clone('b',{name:'Ana',email:'ana@example.invalid'});
  t.after(()=>{try{fs.rmSync(dir,{recursive:true,force:true});}catch{}});
  return {dir,bare,a,b,dataA:path.join(dir,'data-a'),dataB:path.join(dir,'data-b')};
}

test('el libro de encargos viaja por su propia rama: se crea huérfana, se publica, otro clon lo lee y devuelve cambios',async t=>{
  const {bare,a,b,dataA,dataB}=repoWithRemote(t);
  const openedA=await openLedger({projectPath:a,dataDir:dataA,projectId:'proj-1'});
  assert.equal(git(openedA.dir,'rev-parse','--abbrev-ref','HEAD').trim(),LEDGER_BRANCH);
  assert.doesNotMatch(git(openedA.dir,'ls-files'),/base\.txt/,'la rama huérfana no arrastra el código del proyecto');
  assert.equal(git(a,'status','--porcelain').trim(),'','la copia de trabajo del proyecto no se toca');
  writeLedger(openedA.dir,{assignments:[sample],people:[{id:'p-ana',name:'Ana',role:'QA',email:'ana@example.invalid',notes:''}]});
  const published=await publishLedger({dir:openedA.dir,remote:openedA.remote});
  assert.equal(published.committed,true);assert.equal(published.pushed,true,published.error);
  assert.match(git(bare,'branch'),new RegExp(LEDGER_BRANCH));
  assert.doesNotMatch(git(bare,'log','--oneline','main'),/encargos/,'la rama de código no recibe commits de Mixto');
  // El clon de Ana abre el mismo libro desde el remoto.
  const openedB=await openLedger({projectPath:b,dataDir:dataB,projectId:'proj-1'});
  const seenB=await readLedger(openedB.dir);
  assert.equal(seenB.assignments.size,1);
  assert.equal(seenB.people[0].name,'Ana');
  const mine=[...seenB.assignments.values()][0];
  assert.equal(mine.personEmail,'ana@example.invalid');
  // Ana lo pone en curso con una nota y publica; Manuel lo recibe sin haber hecho pull en su rama de código.
  writeLedger(openedB.dir,{assignments:[{...mine,status:'en-curso',updatedAt:'2026-09-15T12:00:00.000Z',notes:[...mine.notes,'2026-09-15 · Ana: empiezo']}]});
  assert.equal((await publishLedger({dir:openedB.dir,remote:openedB.remote})).pushed,true);
  const syncedA=await syncLedger({projectPath:a,dataDir:dataA,projectId:'proj-1',fetch:true});
  assert.equal(syncedA.status.fetched,true);
  assert.equal(syncedA.assignments[0].status,'en-curso');
  assert.deepEqual(syncedA.assignments[0].notes,['2026-09-14 · Manuel: creado','2026-09-15 · Ana: empiezo']);
  assert.equal(git(openedA.dir,'rev-parse','HEAD').trim(),git(openedA.dir,'rev-parse',`origin/${LEDGER_BRANCH}`).trim(),'la rama local queda sobre la punta remota');
  assert.equal(git(a,'status','--porcelain').trim(),'');
});

test('un commit que cita el encargo en cualquier rama lo da por hecho al sincronizar, y las publicaciones cruzadas no chocan',async t=>{
  const {a,b,dataA,dataB}=repoWithRemote(t);
  const openedA=await openLedger({projectPath:a,dataDir:dataA,projectId:'proj-2'});
  writeLedger(openedA.dir,{assignments:[sample],people:[]});
  assert.equal((await publishLedger({dir:openedA.dir,remote:openedA.remote})).pushed,true);
  // Ana trabaja en su rama de código y cita el encargo en el mensaje del commit.
  git(b,'fetch','-q');git(b,'checkout','-q','-b','feature/pago');
  fs.writeFileSync(path.join(b,'pago.txt'),'ok\n');git(b,'add','pago.txt');
  git(b,'commit','-q','-m',`feat: pago con tarjeta\n\nCierra el encargo mixto:${shortId(sample.id)}`);
  git(b,'push','-q','-u','origin','feature/pago');
  assert.deepEqual(await commitsCiting(a,sample.id),[],'antes de traer la rama no hay nada que citar');
  const synced=await syncLedger({projectPath:a,dataDir:dataA,projectId:'proj-2',fetch:true});
  assert.deepEqual(synced.autoDone,[sample.id]);
  assert.equal(synced.assignments[0].status,'hecha');
  assert.match(synced.assignments[0].notes.at(-1),/hecho en el commit [0-9a-f]{7} de Ana: feat: pago con tarjeta/);
  assert.equal((await publishLedger({dir:openedA.dir,remote:openedA.remote})).pushed,true);
  // Mientras tanto Ana también publicó una nota: el push de Manuel se rechaza, se mezcla y sale a la primera al reintentar.
  const openedB=await openLedger({projectPath:b,dataDir:dataB,projectId:'proj-2'});
  const before=[...(await readLedger(openedB.dir)).assignments.values()][0];
  writeLedger(openedB.dir,{assignments:[{...before,updatedAt:'2026-09-16T00:00:00.000Z',notes:[...before.notes,'2026-09-16 · Ana: también probé en tablet']}]});
  assert.equal((await publishLedger({dir:openedB.dir,remote:openedB.remote})).pushed,true);
  writeLedger(openedA.dir,{assignments:[{...(await readLedger(openedA.dir)).assignments.values().next().value,due:'2026-10-15',updatedAt:'2026-09-16T00:00:01.000Z'}]});
  const rejected=await publishLedger({dir:openedA.dir,remote:openedA.remote});
  assert.equal(rejected.pushed,false);
  assert.match(rejected.error,/rejected|fetch first|non-fast-forward|behind/i);
  const merged=await syncLedger({projectPath:a,dataDir:dataA,projectId:'proj-2',fetch:true});
  assert.equal(merged.assignments[0].due,'2026-10-15','manda la versión más reciente');
  assert.ok(merged.assignments[0].notes.includes('2026-09-16 · Ana: también probé en tablet'),'y las notas de la otra parte no se pierden');
  const retried=await publishLedger({dir:openedA.dir,remote:openedA.remote});
  assert.equal(retried.pushed,true,retried.error);
  // Reabrir después del commit que lo cerró: el mismo commit no lo vuelve a cerrar; uno nuevo, sí.
  const reopened={...(await readLedger(openedA.dir)).assignments.values().next().value,status:'en-curso',updatedAt:'2026-09-17T00:00:00.000Z'};
  writeLedger(openedA.dir,{assignments:[reopened]});
  const still=await syncLedger({projectPath:a,dataDir:dataA,projectId:'proj-2',fetch:false});
  assert.equal(still.assignments[0].status,'en-curso');
  assert.deepEqual(still.autoDone,[]);
  fs.writeFileSync(path.join(b,'pago2.txt'),'ok\n');git(b,'add','pago2.txt');git(b,'commit','-q','-m',`fix: scroll mixto:${shortId(sample.id)}`);git(b,'push','-q','origin','feature/pago');
  const again=await syncLedger({projectPath:a,dataDir:dataA,projectId:'proj-2',fetch:true});
  assert.equal(again.assignments[0].status,'hecha');
  assert.equal(again.assignments[0].commits.length,2);
});
