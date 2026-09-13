import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {listPersonas,personaBody} from '../lib/personas.mjs';

test('listPersonas encuentra las dos personas reales con nombre y descripción',()=>{
  const personas=listPersonas();
  assert.equal(personas.length,2);
  const architect=personas.find(p=>p.id==='workflow-architect');
  assert.ok(architect,'falta workflow-architect');
  assert.equal(architect.name,'Workflow Architect');
  assert.match(architect.description,/workflow/i);
  assert.equal(architect.emoji,'🗺️');
  const multi=personas.find(p=>p.id==='multi-agent-systems-architect');
  assert.ok(multi,'falta multi-agent-systems-architect');
  assert.equal(multi.name,'Multi-Agent Systems Architect');
  assert.equal(multi.emoji,'🕸️');
  // El cuerpo largo nunca viaja en el listado: mantiene el snapshot pequeño.
  for(const persona of personas)assert.equal(persona.body,undefined);
});

test('personaBody devuelve el cuerpo sin la cabecera YAML',()=>{
  const body=personaBody('workflow-architect');
  assert.match(body,/Workflow Architect Agent Personality/);
  assert.doesNotMatch(body,/^---/);
  assert.doesNotMatch(body,/^name:/m);
});

test('personaBody devuelve cadena vacía para un id desconocido o vacío',()=>{
  assert.equal(personaBody('no-existe'),'');
  assert.equal(personaBody(''),'');
  assert.equal(personaBody(null),'');
  assert.equal(personaBody(undefined),'');
});

function tempDir(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mixto-personas-')));
  t.after(()=>{try{fs.rmSync(dir,{recursive:true,force:true});}catch{}});
  return dir;
}

test('un archivo sin cabecera YAML válida se ignora sin lanzar',t=>{
  const dir=tempDir(t);
  fs.writeFileSync(path.join(dir,'roto.md'),'# Sin frontmatter\n\nEsto no tiene cabecera.');
  fs.writeFileSync(path.join(dir,'bueno.md'),'---\nname: Bueno\ndescription: Una persona de prueba\nemoji: "🧪"\n---\n\n# Cuerpo\n\nTexto de la persona.');
  const personas=listPersonas(dir);
  assert.deepEqual(personas.map(p=>p.id),['bueno']);
  assert.equal(personas[0].name,'Bueno');
  assert.equal(personas[0].emoji,'🧪');
  assert.equal(personaBody('roto',dir),'');
  assert.match(personaBody('bueno',dir),/Texto de la persona/);
  assert.doesNotMatch(personaBody('bueno',dir),/^---/);
});

test('una carpeta agents/ inexistente no lanza y devuelve una lista vacía',()=>{
  const missing=path.join(os.tmpdir(),'mixto-agents-que-no-existe-'+Date.now());
  assert.deepEqual(listPersonas(missing),[]);
  assert.equal(personaBody('cualquiera',missing),'');
});

test('un archivo con cabecera pero sin name se ignora',t=>{
  const dir=tempDir(t);
  fs.writeFileSync(path.join(dir,'sin-nombre.md'),'---\ndescription: Falta el nombre\n---\n\nCuerpo');
  assert.deepEqual(listPersonas(dir),[]);
});
