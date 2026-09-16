// Reparto ponderado: cuánta cuota le queda a cada agente, qué tamaño tiene la tarea y para qué es mejor cada
// modelo. Con eso Mixto elige agente, modelo y nivel en modo directo («Auto») y se lo cuenta al arquitecto
// para que lo pondere en el plan. No gasta ningún turno: son datos y reglas, no otra llamada al modelo.
export const MAGNITUDES=['pequeña','mediana','grande'];
export const TIERS=['rápido','equilibrado','potente'];
const HOUR=60*60*1000;

export const DEFAULT_MODEL_NOTES=[
  'Modelos rápidos (haiku, mini, nano): cambios mecánicos, preguntas concretas, renombrados, textos. Baratos y casi instantáneos.',
  'Modelos equilibrados (sonnet, gpt-5-codex y similares): la mayoría del trabajo diario: funciones nuevas, arreglos con contexto, tests.',
  'Modelos potentes (opus, max, pro): diseño y arquitectura, refactors que tocan muchas partes, depuración difícil, revisiones exigentes.',
  'Claude Code: explicar y razonar sobre código, cambios cuidadosos en varios archivos, revisión. Codex: trabajo autónomo largo con terminal y tests, iterar hasta que pase la suite.'
].join('\n');

// Tamaño de una petición a partir del texto: longitud, cuántos archivos o áreas nombra y qué verbos usa.
export function estimateMagnitude(text){
  const s=String(text||'').toLowerCase();
  let score=0;
  const words=s.split(/\s+/).filter(Boolean).length;
  if(words>120)score+=2;else if(words>40)score+=1;
  const files=(s.match(/[\w./-]+\.(mjs|js|ts|tsx|jsx|py|go|rs|java|cs|css|html|json|md|sql|yml|yaml)\b/g)||[]).length;
  if(files>=3)score+=2;else if(files>=1)score+=1;
  if(/\b(refactor|refactoriza|migra|migración|arquitectura|rediseñ|reescrib|reestructur|implementa (todo|el sistema|la funcionalidad)|desde cero|toda la app|todo el proyecto|end-to-end|integra|módulo nuevo|varios archivos|múltiples archivos)\b/.test(s))score+=2;
  if(/\b(añade|agrega|crea|implementa|arregla|corrige|cambia|modifica|escribe|genera|tests?|prueba)\b/.test(s))score+=1;
  if(/^(qué|que|cómo|como|dónde|donde|por qué|porque|cuál|cual|explica|explícame|dime|muestra|lista|resume|revisa|busca)\b/.test(s.trim()))score-=1;
  score-=Math.min(2,(s.match(/\b(pequeñ\w*|rápid\w*|solo|únicamente|una línea|un cambio|mínim\w*|typo|errata|tilde|comentario)\b/g)||[]).length);
  return score>=3?'grande':score>=1?'mediana':'pequeña';
}

export function tierOf(modelId){
  const id=String(modelId||'').toLowerCase();
  if(/mini|nano|haiku|flash|lite|small/.test(id))return 'rápido';
  if(/opus|max|pro\b|ultra|xl|large/.test(id))return 'potente';
  return 'equilibrado';
}

// Consumo de Claude Code según los turnos registrados por Mixto: no publica cuota, así que se estima.
export function claudeUsage(messages,now=Date.now()){
  const out={tokens5h:0,turns5h:0,tokens7d:0,turns7d:0};
  for(const m of messages||[]){
    if(m.role!=='assistant'||m.provider!=='claude'||!m.usage)continue;
    const age=now-Date.parse(m.createdAt||0);if(!(age>=0))continue;
    const tokens=Number(m.usage.total)||0;
    if(age<=5*HOUR){out.tokens5h+=tokens;out.turns5h++;}
    if(age<=7*24*HOUR){out.tokens7d+=tokens;out.turns7d++;}
  }
  return out;
}

const fmtTokens=n=>n>=1e6?(n/1e6).toFixed(1).replace('.0','')+' M':n>=1e3?Math.round(n/1e3)+' k':String(n);
const windowLabel=minutes=>!minutes?'su ventana':minutes>=1440?Math.round(minutes/1440)+' días':Math.round(minutes/60)+' h';

// Cuota restante por agente, en porcentaje (null si no se conoce), con una frase para el plan y la interfaz.
export function providerRemaining(provider,{connections,claude,settings}={}){
  if(provider==='codex'){
    const windows=connections?.codex?.limits?.windows||[];
    if(!windows.length)return {percent:null,detail:'Codex: cuota no leída todavía.'};
    const used=Math.max(...windows.map(w=>Number(w.usedPercent)||0));
    return {percent:Math.max(0,Math.min(100,100-used)),detail:`Codex: ${windows.map(w=>`${Math.round(w.usedPercent)} % de ${windowLabel(w.minutes)}`).join(', ')} usado (queda ~${Math.round(100-used)} %).`};
  }
  const usage=claude||{tokens5h:0,turns5h:0,tokens7d:0,turns7d:0};
  const limit=Number(settings?.claudeSoftLimit)||0;
  if(limit>0){
    const used=Math.min(100,usage.tokens5h/limit*100);
    return {percent:Math.max(0,Math.round(100-used)),detail:`Claude Code: ${fmtTokens(usage.tokens5h)} tokens en 5 h de un tope orientativo de ${fmtTokens(limit)} (${Math.round(used)} % usado, ${usage.turns5h} turnos).`};
  }
  return {percent:null,detail:`Claude Code: ${fmtTokens(usage.tokens5h)} tokens y ${usage.turns5h} turnos en las últimas 5 h; no publica su cuota (puedes fijar un tope orientativo en Ajustes).`};
}

const LOW=['low','minimal','none'],HIGH=['high','xhigh','max','ultra'];
function effortFor(entry,magnitude){
  const levels=entry?.efforts||[];if(!levels.length)return null;
  const base=levels.includes(entry.defaultEffort)?entry.defaultEffort:null;
  if(magnitude==='pequeña')return levels.find(level=>LOW.includes(level))||base||levels[0];
  if(magnitude==='grande')return levels.find(level=>level==='high')||levels.find(level=>HIGH.includes(level))||base||levels[levels.length-1];
  return base||levels[Math.floor(levels.length/2)];
}

// Modelo y nivel para una magnitud dentro de un agente: rápido para lo pequeño, potente para lo grande.
export function pickModel(provider,connections,magnitude){
  const models=(connections?.[provider]?.models||[]).filter(m=>!m.hidden&&m.id&&m.id!=='default');
  if(!models.length)return null;
  const fallback=models.find(m=>m.default)||models[0];
  const wanted=magnitude==='pequeña'?'rápido':magnitude==='grande'?'potente':'equilibrado';
  let entry=models.find(m=>tierOf(m.id)===wanted&&(wanted!=='equilibrado'||m.default))||models.find(m=>tierOf(m.id)===wanted)||fallback;
  // Un modelo potente escondido tras «default» (Codex): el predeterminado ya es el equilibrado.
  return {model:entry.id,effort:effortFor(entry,magnitude),tier:tierOf(entry.id)};
}

// Elige agente, modelo y nivel para una petición concreta. Nunca cuesta un turno.
export function chooseAgent({request,connections,messages=[],settings={},now=Date.now(),magnitude}={}){
  const size=magnitude||estimateMagnitude(request);
  const claude=claudeUsage(messages,now);
  const candidates=['claude','codex'].filter(provider=>connections?.[provider]?.connected&&(connections[provider].models||[]).length);
  if(!candidates.length)throw new Error('Ningún agente conectado con modelos: abre Agentes y ajustes.');
  const remaining=Object.fromEntries(candidates.map(provider=>[provider,providerRemaining(provider,{connections,claude,settings})]));
  const score=provider=>remaining[provider].percent===null?100:remaining[provider].percent;
  let viable=candidates.filter(provider=>score(provider)>10);
  if(!viable.length)viable=[...candidates].sort((a,b)=>score(b)-score(a)).slice(0,1);
  const preferred=settings.balance==='claude'||settings.balance==='codex'?settings.balance:null;
  let provider;
  if(preferred&&viable.includes(preferred))provider=preferred;
  else provider=[...viable].sort((a,b)=>score(b)-score(a)||(a==='claude'?-1:1))[0];
  const pick=pickModel(provider,connections,size)||{model:'',effort:null,tier:'equilibrado'};
  const why=[`tarea ${size}`];
  if(preferred&&provider===preferred)why.push(`prefieres ${provider==='claude'?'Claude Code':'Codex'}`);
  else if(preferred&&provider!==preferred)why.push(`${preferred==='claude'?'Claude Code':'Codex'} casi sin cuota`);
  for(const candidate of candidates){const r=remaining[candidate];if(r.percent!==null)why.push(`${candidate==='claude'?'Claude':'Codex'} con ~${r.percent} % de cuota`);}
  const name=provider==='claude'?'Claude Code':'Codex';
  return {provider,model:pick.model,effort:pick.effort,magnitude:size,tier:pick.tier,remaining,reason:`Auto: ${name} · ${pick.model}${pick.effort?' · '+pick.effort:''} (${why.join('; ')}).`};
}

// Bloque para el plan: cuota y consumo de cada agente, más las notas sobre modelos.
export function routingSummary({connections,messages=[],settings={},now=Date.now()}={}){
  const claude=claudeUsage(messages,now);
  const lines=['CUOTA Y CONSUMO DE LOS AGENTES:'];
  for(const provider of ['claude','codex']){
    if(!connections?.[provider]?.connected)continue;
    const r=providerRemaining(provider,{connections,claude,settings});
    lines.push('- '+r.detail+(r.percent!==null&&r.percent<=30?' Está cerca del límite: evita asignarle trabajo salvo que sea imprescindible.':r.percent!==null&&r.percent<=10?' Sin cuota: no lo uses.':''));
  }
  lines.push('PARA QUÉ ES MEJOR CADA MODELO (notas del usuario, editables en Ajustes):');
  lines.push(String(settings.modelNotes||'').trim()||DEFAULT_MODEL_NOTES);
  return lines.join('\n');
}
