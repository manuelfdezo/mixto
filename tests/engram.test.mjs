import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Store,memoryContext} from '../lib/store.mjs';
import {EngramBridge,EngramClient,sharedMemories,cleanupOrphanTransfers} from '../lib/engram.mjs';

const binary=process.env.MIXTO_TEST_ENGRAM_PATH||path.join(os.homedir(),'go','bin',process.platform==='win32'?'engram.exe':'engram');
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('Real Engram: lossless isolated migration, restart, project separation, edits, fallback and recovery',async t=>{
  assert.ok(fs.existsSync(binary),'Install Engram or set MIXTO_TEST_ENGRAM_PATH; never silently skip integration proof');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mixto-engram-test-'));
  const a=path.join(dir,'alpha'),b=path.join(dir,'beta');fs.mkdirSync(a);fs.mkdirSync(b);
  const store=new Store(path.join(dir,'local'),a);
  store.data.projects=[{id:'a',name:'Alpha',path:a},{id:'b',name:'Beta',path:b}];
  store.data.conversations=[{id:'conversation',projectId:'a',title:'Full history',createdAt:'2026-01-01T00:00:00Z'}];
  store.data.messages=[{id:'message',conversationId:'conversation',role:'assistant',provider:'claude',status:'completed',content:'á'.repeat(60000),createdAt:'2026-01-01T00:00:00Z'}];
  store.data.memories=[{id:'note',projectId:'a',title:'Saved',content:'Original note',createdAt:'2026-01-01T00:00:00Z'}, {id:'global',projectId:null,title:'Shared preference',content:'Global preference',createdAt:'2026-01-01T00:00:00Z'}];store.save();
  const original=hash(store.file),originalMessages=structuredClone(store.data.messages);
  const options={binary,dataDir:path.join(dir,'isolated-engram')};
  const client=new EngramClient(options),bridge=new EngramBridge(store,{client});
  await bridge.sync();assert.equal(bridge.status.state,'synced',JSON.stringify(bridge.status));
  assert.equal(hash(store.data.engram.backup.path),original);
  assert.deepEqual(store.data.messages,originalMessages);
  let exported=await client.export();
  assert.equal(exported.observations.length,3);
  assert.equal(exported.observations.find(o=>o.type==='mixto_message').content,originalMessages[0].content);
  assert.equal(exported.prompts?.length||0,0);
  const restarted=new Store(path.dirname(store.file),a),again=new EngramBridge(restarted,{client});
  await again.sync();assert.equal((await client.export()).observations.length,3);
  await client.import({sessions:[{id:'external',project:'alpha',directory:a,started_at:'2026-01-01T00:00:00Z'}],observations:[
    {sync_id:'external-a',session_id:'external',type:'discovery',title:'Agent note',content:'Both agents see this',project:'alpha',scope:'project',created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z'},
    {sync_id:'external-b',session_id:'external',type:'discovery',title:'Private B',content:'SECRET_B',project:'beta',scope:'project',created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z'},
    {sync_id:'external-global',session_id:'external',type:'discovery',title:'Unscoped',content:'SECRET_GLOBAL',scope:'personal',created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z'}],prompts:[]});
  await again.sync();
  const context=memoryContext({...restarted.data,memories:sharedMemories(restarted.data)},'a','new','agents');
  assert.match(context,/Both agents/);assert.doesNotMatch(context,/SECRET_/);
  restarted.data.memories.find(m=>m.id==='note').content='Edited note';restarted.save();await again.sync();
  exported=await client.export();assert.equal(exported.observations.filter(o=>o.title==='Saved').length,1);assert.equal(exported.observations.find(o=>o.title==='Saved').content,'Edited note');
  restarted.data.memories=restarted.data.memories.filter(m=>m.id!=='note');restarted.save();await again.sync();
  assert.ok((await client.export()).observations.find(o=>o.title==='Saved').deleted_at);
  const failing=new EngramBridge(restarted,{client:new EngramClient({...options,binary:path.join(dir,'missing.exe')})});
  await failing.sync();assert.equal(failing.status.state,'offline');assert.match(JSON.stringify(sharedMemories(restarted.data)),/Both agents/);
  await again.sync();assert.equal(again.status.state,'synced');
  assert.equal(fs.readdirSync(options.dataDir).some(n=>n.startsWith('mixto-transfer')),false);
  t.diagnostic(`Isolated Engram DB: ${options.dataDir}; no production data directory passed to any child`);
});

test('cleanupOrphanTransfers borra carpetas mixto-transfer-* huérfanas sin tocar otras carpetas temporales',()=>{
  const tmp=os.tmpdir();
  const orphan=fs.mkdtempSync(path.join(tmp,'mixto-transfer-'));
  fs.writeFileSync(path.join(orphan,'transfer.json'),'{}');
  const unrelated=fs.mkdtempSync(path.join(tmp,'mixto-test-unrelated-'));
  try{
    cleanupOrphanTransfers();
    assert.equal(fs.existsSync(orphan),false);
    assert.equal(fs.existsSync(unrelated),true);
  } finally {fs.rmSync(unrelated,{recursive:true,force:true});}
});
