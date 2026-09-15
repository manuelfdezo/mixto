import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {compareVersions,updateSources,checkUpdate,applyUpdate,extractedRoot,listFiles,downloadUpdate} from '../lib/update.mjs';
import {buildZip} from '../lib/zip.mjs';

const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'mixto-upd-'));
const write=(dir,rel,content)=>{fs.mkdirSync(path.dirname(path.join(dir,rel)),{recursive:true});fs.writeFileSync(path.join(dir,rel),content);};
const read=(dir,rel)=>fs.readFileSync(path.join(dir,rel),'utf8');

test('las versiones se comparan por números, no por texto',()=>{
  assert.equal(compareVersions('1.2.0','1.10.0'),-1);
  assert.equal(compareVersions('1.10.0','1.2.0'),1);
  assert.equal(compareVersions('1.2','1.2.0'),0);
  assert.equal(compareVersions('2.0.0','1.99.99'),1);
  assert.equal(compareVersions(undefined,'0.0.1'),-1);
});

test('las fuentes apuntan a GitHub por defecto y se pueden cambiar por entorno',()=>{
  const sources=updateSources({});
  assert.equal(sources.manifestUrl,'https://raw.githubusercontent.com/manuelfdezo/mixto/main/package.json');
  assert.equal(sources.zipUrl,'https://github.com/manuelfdezo/mixto/archive/refs/heads/main.zip');
  assert.equal(sources.enabled,true);
  const local=updateSources({MIXTO_UPDATE_BASE:'http://127.0.0.1:1/x',MIXTO_UPDATE_ZIP:'http://127.0.0.1:1/x/m.zip',MIXTO_UPDATE_CHECK:'off'});
  assert.equal(local.manifestUrl,'http://127.0.0.1:1/x/package.json');
  assert.equal(local.enabled,false);
});

test('comprobar la versión distingue una nueva, la misma y una respuesta que no es Mixto',async()=>{
  const sources=updateSources({MIXTO_UPDATE_BASE:'http://x/'});
  const fake=body=>async()=>({ok:true,json:async()=>body});
  assert.deepEqual(await checkUpdate({current:'1.2.0',sources,fetchImpl:fake({name:'mixto',version:'1.3.0'})}),{latest:'1.3.0',available:true});
  assert.deepEqual(await checkUpdate({current:'1.2.0',sources,fetchImpl:fake({name:'mixto',version:'1.2.0'})}),{latest:'1.2.0',available:false});
  await assert.rejects(checkUpdate({current:'1.2.0',sources,fetchImpl:fake({name:'otro',version:'9'})}),/no es la versión de Mixto/);
  await assert.rejects(checkUpdate({current:'1.2.0',sources,fetchImpl:async()=>({ok:false,status:503})}),/503/);
});

test('aplicar una versión sustituye, añade y retira archivos, respeta data y .runtime y guarda copia',()=>{
  const root=temp(),source=temp();
  write(root,'server.mjs','viejo');write(root,'lib/a.mjs','a');write(root,'lib/borrar.mjs','se va');write(root,'dist/app.js','app');
  write(root,'data/mixto.json','{"mío":true}');write(root,'.runtime/node/node.exe','bin');write(root,'package.json','{"name":"mixto","version":"1.0.0"}');
  const manifestFile=path.join(root,'.runtime','instalado.json');
  fs.writeFileSync(manifestFile,JSON.stringify({version:'1.0.0',files:['server.mjs','lib/a.mjs','lib/borrar.mjs','dist/app.js','package.json','data/trampa.json']}));
  write(source,'server.mjs','nuevo');write(source,'lib/a.mjs','a');write(source,'lib/nuevo.mjs','n');write(source,'dist/app.js','app2');
  write(source,'package.json','{"name":"mixto","version":"1.1.0"}');write(source,'data/no-debe-copiarse.txt','x');
  const result=applyUpdate({root,sourceDir:source,manifestFile,backupDir:path.join(root,'.runtime','backup','1.0.0')});
  assert.deepEqual(result,{version:'1.1.0',copied:4,removed:1});
  assert.equal(read(root,'server.mjs'),'nuevo');
  assert.equal(read(root,'lib/nuevo.mjs'),'n');
  assert.equal(fs.existsSync(path.join(root,'lib/borrar.mjs')),false,'lo que ya no existe se retira');
  assert.equal(read(root,'data/mixto.json'),'{"mío":true}','data no se toca');
  assert.equal(fs.existsSync(path.join(root,'data/no-debe-copiarse.txt')),false,'data de la descarga se ignora');
  assert.equal(read(root,'.runtime/node/node.exe'),'bin','.runtime no se toca');
  assert.equal(read(root,'.runtime/backup/1.0.0/server.mjs'),'viejo','copia de lo sustituido');
  assert.equal(read(root,'.runtime/backup/1.0.0/lib/borrar.mjs'),'se va','copia de lo retirado');
  assert.equal(fs.existsSync(path.join(root,'server.mjs.mixto-nuevo')),false);
  const manifest=JSON.parse(read(root,'.runtime/instalado.json'));
  assert.equal(manifest.version,'1.1.0');
  assert.deepEqual(manifest.files,['dist/app.js','lib/a.mjs','lib/nuevo.mjs','package.json','server.mjs']);
  // Volver a aplicar lo mismo no copia nada.
  assert.deepEqual(applyUpdate({root,sourceDir:source,manifestFile}),{version:'1.1.0',copied:0,removed:0});
  write(source,'package.json','{"name":"otro","version":"1.1.0"}');
  assert.throws(()=>applyUpdate({root,sourceDir:source,manifestFile}),/no es Mixto/);
});

test('la descarga se extrae y se localiza la carpeta de la app aunque venga envuelta',async()=>{
  const zip=buildZip([{name:'mixto-main',dir:true},{name:'mixto-main/package.json',data:Buffer.from('{"name":"mixto","version":"2.0.0"}')},{name:'mixto-main/server.mjs',data:Buffer.from('// servidor')},{name:'mixto-main/lib',dir:true},{name:'mixto-main/lib/x.mjs',data:Buffer.from('x')}]);
  const into=temp();
  const {dir,sourceDir}=await downloadUpdate({sources:{zipUrl:'http://x/m.zip'},into,fetchImpl:async()=>({ok:true,arrayBuffer:async()=>zip.buffer.slice(zip.byteOffset,zip.byteOffset+zip.byteLength)})});
  assert.equal(path.basename(sourceDir),'mixto-main');
  assert.ok(dir.startsWith(into));
  assert.deepEqual(listFiles(sourceDir),['lib/x.mjs','package.json','server.mjs']);
  assert.equal(extractedRoot(sourceDir),sourceDir);
  assert.throws(()=>extractedRoot(temp()),/no contiene Mixto/);
  await assert.rejects(downloadUpdate({sources:{zipUrl:'http://x/m.zip'},into,fetchImpl:async()=>({ok:false,status:404})}),/404/);
});
