import assert from 'node:assert/strict';
const origin='http://127.0.0.1:4317';
const root=await fetch(origin+'/');assert.equal(root.status,200);
const cookie=root.headers.get('set-cookie').split(';')[0];
let r=await fetch(origin+'/api/state');assert.equal(r.status,401);
r=await fetch(origin+'/api/state',{headers:{Cookie:cookie,Origin:'https://example.com'}});assert.equal(r.status,403);
r=await fetch(origin+'/api/projects',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,403);
r=await fetch(origin+'/api/state',{headers:{Cookie:cookie}});assert.equal(r.status,200);
const state=await r.json();assert.equal(state.version,1);assert.ok(state.projects.length);
for(const file of ['/app.js','/style.css','/favicon.svg']){r=await fetch(origin+file);assert.equal(r.status,200);}
r=await fetch(origin+'/data/mixto.json',{headers:{Cookie:cookie}});assert.equal(r.status,404);
r=await fetch(origin+'/api/export',{headers:{Cookie:cookie}});assert.equal(r.status,200);assert.match(r.headers.get('content-disposition'),/attachment/);
console.log('HTTP verificado: sesión local, protección de origen, mutaciones protegidas, recursos, datos privados y exportación.');
console.log(JSON.stringify(Object.fromEntries(Object.entries(state.connections).map(([p,c])=>[p,{connected:c.connected,models:c.models.length}]))));
