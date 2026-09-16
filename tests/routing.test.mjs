import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateMagnitude,tierOf,claudeUsage,providerRemaining,pickModel,chooseAgent,routingSummary,DEFAULT_MODEL_NOTES} from '../lib/routing.mjs';

const connections={
  claude:{connected:true,models:[{id:'claude-haiku-4-5',efforts:['low','medium','high'],defaultEffort:'medium'},{id:'claude-sonnet-4-5',default:true,efforts:['low','medium','high'],defaultEffort:'medium'},{id:'claude-opus-4-1',efforts:['low','medium','high','max'],defaultEffort:'medium'}]},
  codex:{connected:true,models:[{id:'gpt-5-codex',default:true,efforts:['low','medium','high','xhigh'],defaultEffort:'medium'},{id:'gpt-5.1-codex-mini',efforts:['low','medium','high'],defaultEffort:'medium'}],limits:{windows:[{usedPercent:34,minutes:300},{usedPercent:12,minutes:10080}]}}
};

test('la magnitud de una petición sale de su texto',()=>{
  assert.equal(estimateMagnitude('¿Qué hace base.txt?'),'pequeña');
  assert.equal(estimateMagnitude('Añade validación de correo al formulario de alta y cubre el caso con tests'),'mediana');
  assert.equal(estimateMagnitude('Refactoriza toda la app para separar la capa de datos en src/db.ts, src/api.ts y src/ui.tsx, migra los tests y documenta la arquitectura nueva con un módulo nuevo por dominio'),'grande');
  assert.equal(estimateMagnitude('Arregla solo el typo de una línea en README.md'),'pequeña');
});

test('los modelos se clasifican por familia y se elige el que casa con la magnitud',()=>{
  assert.equal(tierOf('claude-haiku-4-5'),'rápido');assert.equal(tierOf('gpt-5.1-codex-mini'),'rápido');
  assert.equal(tierOf('claude-opus-4-1'),'potente');assert.equal(tierOf('gpt-5-codex'),'equilibrado');
  assert.deepEqual(pickModel('claude',connections,'pequeña'),{model:'claude-haiku-4-5',effort:'low',tier:'rápido'});
  assert.deepEqual(pickModel('claude',connections,'mediana'),{model:'claude-sonnet-4-5',effort:'medium',tier:'equilibrado'});
  assert.deepEqual(pickModel('claude',connections,'grande'),{model:'claude-opus-4-1',effort:'high',tier:'potente'});
  assert.deepEqual(pickModel('codex',connections,'grande'),{model:'gpt-5-codex',effort:'high',tier:'equilibrado'},'sin modelo potente, el predeterminado con nivel alto');
  assert.equal(pickModel('codex',{codex:{models:[]}},'mediana'),null);
});

test('el consumo de Claude se estima con los turnos registrados y la cuota restante se explica',()=>{
  const now=Date.parse('2026-09-16T12:00:00Z');
  const messages=[
    {role:'assistant',provider:'claude',usage:{total:120000},createdAt:'2026-09-16T10:00:00Z'},
    {role:'assistant',provider:'claude',usage:{total:50000},createdAt:'2026-09-15T12:00:00Z'},
    {role:'assistant',provider:'codex',usage:{total:999999},createdAt:'2026-09-16T11:00:00Z'},
    {role:'user',provider:'claude',usage:{total:1},createdAt:'2026-09-16T11:00:00Z'}
  ];
  assert.deepEqual(claudeUsage(messages,now),{tokens5h:120000,turns5h:1,tokens7d:170000,turns7d:2});
  const claude=claudeUsage(messages,now);
  assert.equal(providerRemaining('codex',{connections}).percent,66);
  assert.match(providerRemaining('codex',{connections}).detail,/34 % de 5 h, 12 % de 7 días usado \(queda ~66 %\)/);
  assert.equal(providerRemaining('claude',{connections,claude,settings:{}}).percent,null);
  assert.equal(providerRemaining('claude',{connections,claude,settings:{claudeSoftLimit:200000}}).percent,40);
  assert.match(providerRemaining('claude',{connections,claude,settings:{claudeSoftLimit:200000}}).detail,/120 k tokens en 5 h de un tope orientativo de 200 k \(60 % usado, 1 turnos\)/);
});

test('Auto elige el agente con más cuota, respeta la preferencia mientras haya cuota y evita al que se agota',()=>{
  const now=Date.now();
  const small=chooseAgent({request:'¿Qué hace este archivo?',connections,settings:{balance:'auto'},now});
  assert.equal(small.provider,'claude','sin tope de Claude, se considera disponible y gana a Codex al 66 %');
  assert.equal(small.model,'claude-haiku-4-5');assert.equal(small.magnitude,'pequeña');
  assert.match(small.reason,/^Auto: Claude Code · claude-haiku-4-5 · low \(tarea pequeña; Codex con ~66 % de cuota\)\.$/);
  const preferCodex=chooseAgent({request:'Añade tests al módulo de pagos',connections,settings:{balance:'codex'},now});
  assert.equal(preferCodex.provider,'codex');assert.equal(preferCodex.model,'gpt-5-codex');
  // Claude con tope y agotado: aunque se prefiera, se pasa a Codex y se explica.
  const messages=[{role:'assistant',provider:'claude',usage:{total:95000},createdAt:new Date(now-HOUR()).toISOString()}];
  const exhausted=chooseAgent({request:'Arregla el bug del login',connections,messages,settings:{balance:'claude',claudeSoftLimit:100000},now});
  assert.equal(exhausted.provider,'codex');assert.match(exhausted.reason,/Claude Code casi sin cuota/);
  // Codex agotado y Claude sin tope: Claude.
  const codexOut={...connections,codex:{...connections.codex,limits:{windows:[{usedPercent:95,minutes:300}]}}};
  assert.equal(chooseAgent({request:'x',connections:codexOut,settings:{balance:'codex'},now}).provider,'claude');
  // Solo un agente conectado.
  assert.equal(chooseAgent({request:'x',connections:{codex:connections.codex},settings:{},now}).provider,'codex');
  assert.throws(()=>chooseAgent({request:'x',connections:{},settings:{}}),/Ningún agente conectado/);
  function HOUR(){return 60*60*1000;}
});

test('el resumen para el plan lleva cuota, consumo y notas, con avisos cerca del límite',()=>{
  const text=routingSummary({connections,settings:{}});
  assert.match(text,/CUOTA Y CONSUMO DE LOS AGENTES:/);
  assert.match(text,/Claude Code: 0 tokens y 0 turnos/);
  assert.match(text,/Codex: 34 % de 5 h/);
  assert.ok(text.includes(DEFAULT_MODEL_NOTES));
  const tight={...connections,codex:{...connections.codex,limits:{windows:[{usedPercent:80,minutes:300}]}}};
  assert.match(routingSummary({connections:tight,settings:{modelNotes:'Mis notas'}}),/queda ~20 %\)\. Está cerca del límite/);
  assert.match(routingSummary({connections:tight,settings:{modelNotes:'Mis notas'}}),/Mis notas/);
});
