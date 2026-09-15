import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {extractZip,buildZip,crc32,safeEntryName} from '../lib/zip.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('crc32 coincide con el valor conocido y los nombres peligrosos se rechazan',()=>{
  assert.equal(crc32(Buffer.from('123456789')),0xCBF43926);
  assert.equal(crc32(Buffer.alloc(0)),0);
  assert.equal(safeEntryName('lib/zip.mjs'),'lib/zip.mjs');
  for(const bad of ['../x','a/../../x','/etc/passwd','C:/x','a\\b','',null])assert.equal(safeEntryName(bad),null,String(bad));
});

test('un zip almacenado va y vuelve, con carpetas y nombres en UTF-8',()=>{
  const zip=buildZip([{name:'carpeta',dir:true},{name:'carpeta/año.txt',data:Buffer.from('áéñ\n')},{name:'vacío.txt',data:Buffer.alloc(0)}]);
  const entries=extractZip(zip);
  assert.deepEqual(entries.map(e=>[e.name,e.dir]),[['carpeta/',true],['carpeta/año.txt',false],['vacío.txt',false]]);
  assert.equal(entries[1].data.toString('utf8'),'áéñ\n');
  assert.equal(entries[2].data.length,0);
});

test('extrae el zip con deflate que produce git archive, igual que GitHub',()=>{
  const zip=execFileSync('git',['archive','--format=zip','--prefix=mixto-main/','HEAD'],{cwd:root,maxBuffer:64*1024*1024});
  const entries=extractZip(zip);
  const byName=new Map(entries.map(e=>[e.name,e]));
  assert.ok(byName.get('mixto-main/')?.dir,'la carpeta raíz es un directorio');
  const server=byName.get('mixto-main/server.mjs');
  assert.ok(server&&!server.dir);
  assert.equal(server.data.toString('utf8'),execFileSync('git',['show','HEAD:server.mjs'],{cwd:root,maxBuffer:64*1024*1024}).toString('utf8'));
  assert.ok(byName.has('mixto-main/dist/mixto.ico'),'los binarios también viajan');
});

test('un zip con rutas fuera de la carpeta o dañado se rechaza',()=>{
  const evil=buildZip([{name:'../fuera.txt',data:Buffer.from('x')}]);
  assert.throws(()=>extractZip(evil),/Ruta no permitida/);
  const zip=buildZip([{name:'a.txt',data:Buffer.from('hola')}]);
  zip[zip.indexOf(Buffer.from('hola'))]=0x4a; // «jola»: el CRC ya no cuadra
  assert.throws(()=>extractZip(zip),/dañado/);
  assert.throws(()=>extractZip(Buffer.from('no es un zip')),/no es un zip/);
});
