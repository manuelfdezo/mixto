import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {Store,memoryContext} from '../lib/store.mjs';
import {runProvider,executables,resolveCommand,normalizeUsage,normalizeLimits} from '../lib/providers.mjs';
import {commandAllowed,commandPrefix,cleanCommandList,claudeAllowedTools,looksLikeSessionLoss} from '../lib/commands.mjs';
import {parseDiff} from '../lib/isolation.mjs';

test('La memoria y las conversaciones sobreviven al reinicio, con copia anterior',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mixto-test-store-'));
  const a=new Store(dir,dir);
  assert.deepEqual(a.data.projects,[],'a new Mixto store must not treat the orchestrator repository as a product project');
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
    // El consumo llega normalizado con la misma forma para los dos agentes.
    assert.equal(result.usage.total,provider==='claude'?150:120);
    assert.equal(result.usage.cached,30);
    assert.equal(result.usage.costUsd,provider==='claude'?0.0123:0);
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

// Un CLI instalado con npm en Windows solo existe como atajo .cmd: Node no puede lanzarlo directamente.
const enWindows={skip:process.platform!=='win32'?'solo aplica a Windows':false};

test('resolveCommand pasa de largo cuando ya recibe un comando con argumentos',()=>{
  const orden=[process.execPath,'agente.mjs','codex'];
  assert.deepEqual(resolveCommand(orden),orden);
});

test('resolveCommand entrega los atajos .cmd al intérprete y deja los .exe en paz',enWindows,()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mixto-cmd-'));
  const atajo=path.join(dir,'agente.cmd'),programa=path.join(dir,'agente.exe');
  fs.writeFileSync(atajo,'@echo off\n');fs.writeFileSync(programa,'');
  try{
    assert.deepEqual(resolveCommand(atajo),[process.env.ComSpec||'cmd.exe','/d','/s','/c',atajo]);
    assert.deepEqual(resolveCommand(programa),[programa]);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('resolveCommand encuentra el atajo por PATH, como haría una terminal',enWindows,()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mixto-path-'));
  fs.writeFileSync(path.join(dir,'agentefalso.cmd'),'@echo off\n');
  const anterior=process.env.PATH;
  process.env.PATH=dir+path.delimiter+anterior;
  try{
    assert.deepEqual(resolveCommand('agentefalso'),
      [process.env.ComSpec||'cmd.exe','/d','/s','/c',path.join(dir,'agentefalso.cmd')]);
    // Un comando que no existe se devuelve tal cual, para que el fallo siga siendo un ENOENT claro.
    assert.deepEqual(resolveCommand('no-existe-este-agente'),['no-existe-este-agente']);
  }finally{process.env.PATH=anterior;fs.rmSync(dir,{recursive:true,force:true});}
});

test('normalizeUsage entiende el formato de cada agente y descarta lo vacío',()=>{
  assert.deepEqual(normalizeUsage('claude',{input_tokens:10,cache_read_input_tokens:5,cache_creation_input_tokens:2,output_tokens:3},0.5),
    {input:10,cached:7,output:3,total:20,costUsd:0.5});
  assert.deepEqual(normalizeUsage('codex',{inputTokens:10,cachedInputTokens:4,outputTokens:6,totalTokens:16}),
    {input:10,cached:4,output:6,total:16,costUsd:0});
  assert.equal(normalizeUsage('codex',{inputTokens:10,outputTokens:6}).total,16,'sin total declarado se suma');
  assert.equal(normalizeUsage('claude',null),null);
  assert.equal(normalizeUsage('claude',{}),null);
});

test('normalizeLimits encuentra las ventanas de cuota sin depender de la forma exacta',()=>{
  const limits=normalizeLimits({rateLimits:{primary:{usedPercent:34,windowDurationMins:300,resetsAt:1800000000},secondary:{usedPercent:12,windowDurationMins:10080}}});
  assert.equal(limits.windows.length,2);
  assert.deepEqual(limits.windows.map(w=>[w.usedPercent,w.minutes]),[[34,300],[12,10080]]);
  assert.equal(limits.windows[0].resetsAt,new Date(1800000000*1000).toISOString());
  assert.equal(limits.windows[1].resetsAt,null);
  assert.equal(normalizeLimits({}),null);
  assert.equal(normalizeLimits(null),null);
  assert.equal(normalizeLimits({used_percent:250}).windows[0].usedPercent,100,'se acota a 100');
  // Codex real: los mismos límites llegan también en rateLimitsByLimitId; no deben salir por duplicado.
  const doubled=normalizeLimits({rateLimits:{primary:{usedPercent:0,windowDurationMins:300},secondary:{usedPercent:0,windowDurationMins:10080}},
    rateLimitsByLimitId:{codex:{primary:{usedPercent:0,windowDurationMins:300},secondary:{usedPercent:0,windowDurationMins:10080}}}});
  assert.deepEqual(doubled.windows.map(w=>[w.minutes,w.usedPercent]),[[300,0],[10080,0]]);
  const repeated=normalizeLimits({limits:[{usedPercent:5,windowMinutes:300},{usedPercent:9,windowMinutes:300,resetsAt:1800000000}]});
  assert.deepEqual(repeated.windows.map(w=>[w.minutes,w.usedPercent,w.resetsAt]),[[300,9,new Date(1800000000*1000).toISOString()]],'una ventana repetida se queda una vez, con el mayor uso');
});

test('los comandos permitidos casan por prefijo de palabra completa y se guardan limpios',()=>{
  const list=['npm test','git status'];
  assert.equal(commandAllowed(list,'npm test'),true);
  assert.equal(commandAllowed(list,'npm   test -- --watch'),true,'los espacios de más no importan');
  assert.equal(commandAllowed(list,'npm testing'),false,'no vale un prefijo a medias');
  assert.equal(commandAllowed(list,'rm -rf /'),false);
  assert.equal(commandAllowed([],'npm test'),false);
  assert.equal(commandPrefix('pytest tests/test_x.py -q'),'pytest tests/test_x.py');
  assert.equal(commandPrefix('ls'),'ls');
  assert.deepEqual(cleanCommandList([' npm test ','npm test','','git status',42]),['npm test','git status']);
  assert.deepEqual(claudeAllowedTools(['npm test']),['Bash(npm test)','Bash(npm test:*)','Bash(npm test *)']);
  assert.equal(looksLikeSessionLoss(new Error('No conversation found with session ID x')),true);
  assert.equal(looksLikeSessionLoss(new Error('ENOENT')),false);
});

test('parseDiff separa archivos, cuenta líneas y reconoce nuevos, borrados y binarios',()=>{
  const text=['diff --git a/a.txt b/a.txt','index 1..2 100644','--- a/a.txt','+++ b/a.txt','@@ -1 +1,2 @@','-uno','+uno','+dos',
    'diff --git a/nuevo.txt b/nuevo.txt','new file mode 100644','--- /dev/null','+++ b/nuevo.txt','@@ -0,0 +1 @@','+hola',
    'diff --git a/viejo.txt b/viejo.txt','deleted file mode 100644','--- a/viejo.txt','+++ /dev/null','@@ -1 +0,0 @@','-adiós',
    'diff --git a/img.png b/img.png','Binary files a/img.png and b/img.png differ'].join('\n');
  const files=parseDiff(text);
  assert.deepEqual(files.map(f=>[f.path,f.status,f.additions,f.deletions,f.binary]),[['a.txt','modified',2,1,false],['nuevo.txt','added',1,0,false],['viejo.txt','deleted',0,1,false],['img.png','modified',0,0,true]]);
  assert.match(files[0].text,/^diff --git a\/a\.txt/);
  assert.deepEqual(parseDiff(''),[]);
  assert.equal(parseDiff('diff --git "a/con espacio.txt" "b/con espacio.txt"\n+x')[0].path,'con espacio.txt');
});
