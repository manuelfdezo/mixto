import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {Store,memoryContext} from '../lib/store.mjs';
import {runProvider,executables} from '../lib/providers.mjs';

test('La memoria y las conversaciones sobreviven al reinicio, con copia anterior',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mixto-test-store-'));
  const a=new Store(dir,dir);
  a.data.memories.push({id:'saved',content:'Recuerdo persistente'});
  a.data.runs.push({status:'running'});a.data.messages.push({status:'streaming'});a.save();
  const b=new Store(dir,dir);
  assert.equal(b.data.memories[0].content,'Recuerdo persistente');
  assert.equal(b.data.runs[0].status,'interrupted');assert.equal(b.data.messages[0].status,'interrupted');
  assert.ok(fs.existsSync(path.join(dir,'mixto.json.bak')));
});
test('Un archivo corrupto no se sustituye silenciosamente',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mixto-test-corrupt-'));
  fs.writeFileSync(path.join(dir,'mixto.json'),'{invalid');
  assert.throws(()=>new Store(dir,dir));assert.equal(fs.readFileSync(path.join(dir,'mixto.json'),'utf8'),'{invalid');
});
test('El contexto respeta proyectos, notas globales y relevancia',()=>{
  const memories=[
    {projectId:'a',content:'preferencia explícita',createdAt:'2026-01-01'},
    {projectId:null,content:'global español',createdAt:'2026-01-01'},
    {projectId:'b',content:'SECRETO DE OTRO PROYECTO',createdAt:'2026-01-01'},
    {projectId:'a',content:'sqlite migraciones',automatic:true,conversationId:'old',createdAt:'2026-01-01'},
    {projectId:'a',content:'CONTEXTO YA PRESENTE',automatic:true,conversationId:'current',createdAt:'2026-01-01'},
    ...Array.from({length:9},(_,i)=>({projectId:'a',content:'otro trabajo '+i,automatic:true,conversationId:'old',createdAt:'2026-02-01'}))
  ];
  const context=memoryContext({memories},'a','current','sqlite migraciones');
  assert.match(context,/preferencia explícita/);assert.match(context,/global español/);assert.match(context,/sqlite migraciones/);
  assert.doesNotMatch(context,/SECRETO|CONTEXTO YA/);assert.equal((context.match(/Registro de trabajo/g)||[]).length,5);
});

const mock=fileURLToPath(new URL('./fake-agent.mjs',import.meta.url));
for(const provider of ['codex','claude']){
  executables[provider]=[process.execPath,mock,provider];
  const opts=(prompt,other={})=>({cwd:process.cwd(),model:'test',prompt,readOnly:true,signal:new AbortController().signal,onText:()=>{},onEvent:()=>{},onSession:()=>{},approve:async()=>({allow:false}),...other});
  test(`${provider}: streaming UTF-8 y resultado sin duplicados`,async()=>{
    let displayed='',session;
    const result=await runProvider(provider,opts('OK',{onText:t=>displayed=t,onSession:s=>session=s}));
    assert.equal(result.text,'Respuesta verificada: áéñ');assert.equal(displayed.trim(),result.text);assert.equal(session,'native-'+provider);
  });
  test(`${provider}: fallo del agente no se interpreta como éxito`,async()=>{
    await assert.rejects(runProvider(provider,opts('ERROR')),/Fallo controlado/);
  });
  test(`${provider}: permisos propagados al usuario en modo trabajo`,async()=>{
    let asked=0;
    const result=await runProvider(provider,opts('PERMISSION',{readOnly:false,approve:async()=>{asked++;return {allow:true};}}));
    assert.equal(asked,1);assert.equal(result.text,'Permitido');
  });
  test(`${provider}: consulta no permite escaladas de escritura`,async()=>{
    let asked=0;
    const result=await runProvider(provider,opts('PERMISSION',{approve:async()=>{asked++;return {allow:true};}}));
    assert.equal(asked,0);assert.equal(result.text,'Rechazado');
  });
  test(`${provider}: detener una tarea libera la espera`,async()=>{
    const controller=new AbortController();const running=runProvider(provider,opts('WAIT',{signal:controller.signal}));
    const timer=setTimeout(()=>controller.abort(),300);
    try{await assert.rejects(running,/detenida/);}finally{clearTimeout(timer);}
  });
}
