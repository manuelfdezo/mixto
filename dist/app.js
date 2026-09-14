const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={codex:'Codex',claude:'Claude Code'};
const symbols={codex:'✳',claude:'✺'};
const effortNames={low:'Ligero',medium:'Equilibrado',high:'Alto',xhigh:'Muy alto',max:'Máximo',ultra:'Ultra'};
const stageNames={queued:'En espera',running:'Trabajando',waiting:'Esperando tu respuesta',completed:'Completado',error:'Sin completar',cancelled:'Detenido',stopped:'Detenida por el arquitecto',interrupted:'Interrumpido'};
const fmtTokens=n=>n>=1e6?(n/1e6).toFixed(1).replace('.',',')+' M':n>=1000?(n/1000).toFixed(1).replace('.',',')+' k':String(n);
const fmtCost=c=>c?(Math.round(c*1000)/1000).toString().replace('.',',')+' $':'';
const usageText=u=>u?.total?`${fmtTokens(u.total)} tokens${u.costUsd?' · '+fmtCost(u.costUsd):''}`:'';
const windowLabel=m=>m==null?'ventana':m<60?`${m} min`:m<1440?`${Math.round(m/60)} h`:`${Math.round(m/1440)} días`;
function quotaText(provider){const w=state?.connections[provider]?.limits?.windows;if(!w?.length)return '';return w.map(x=>`${Math.round(x.usedPercent)} % de ${windowLabel(x.minutes)}`).join(' · ');}
// Cada turno lleva su consumo; la respuesta directa y la revisión llevan además el total de la tarea.
function usageBadges(m){
  const own=usageText(m.usage);
  const run=(m.kind==='review'||m.kind==='answer')?state.runs.find(r=>r.id===m.runId):null;
  const total=run?.usage?.total&&run.usage.turns>1?`${usageText(run.usage)} · ${run.usage.turns} turnos`:'';
  return (own?`<span class="message-usage" title="Consumo de este turno">${own}</span>`:'')+(total?`<span class="message-usage" title="Consumo total de la tarea, con el plan y la revisión">tarea: ${total}</span>`:'');
}
function limitsHtml(p,c){
  const w=c.limits?.windows;
  if(w?.length)return `<div class="metadata">Cuota usada: ${w.map(x=>`${Math.round(x.usedPercent)} % de ${windowLabel(x.minutes)}${x.resetsAt?` (se reinicia ${new Date(x.resetsAt).toLocaleString('es',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})})`:''}`).join(' · ')}</div>`;
  if(p==='claude'&&c.connected)return '<div class="metadata">Claude Code no publica su cuota; el consumo se muestra por turno y por tarea en la conversación.</div>';
  return '';
}
let state,projectId,conversationId,orchestrator='codex',busy=false,lastMessages='',lastAgents='',lastMemory='',lastRun='',toastTimer;
let planChoices={},initRepo=false;
let mode='orquestar',manualRows=[],manualOptions={review:true,initRepo:false},manualVersion=0,lastManual='';
let preferences;try{preferences=JSON.parse(localStorage.getItem('mixto-preferences')||'{}');}catch{preferences={};}
const selections=preferences.models||{},efforts=preferences.efforts||{};
projectId=preferences.projectId;conversationId=preferences.conversationId;
if(['codex','claude'].includes(preferences.orchestrator))orchestrator=preferences.orchestrator;
if(['orquestar','directo','manual'].includes(preferences.mode))mode=preferences.mode;
if(Array.isArray(preferences.manualDraft))manualRows=preferences.manualDraft.filter(r=>r&&typeof r==='object');
if(preferences.manualOptions&&typeof preferences.manualOptions==='object')manualOptions={...manualOptions,...preferences.manualOptions};

async function api(route,body,method=body===undefined?'GET':'POST'){
  const response=await fetch('/api/'+route,{method,headers:body===undefined?{}:{'Content-Type':'application/json','X-Mixto-Client':'1'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'No se pudo completar la acción.');return data;
}
function remember(){try{localStorage.setItem('mixto-preferences',JSON.stringify({projectId,conversationId,orchestrator,mode,models:selections,efforts,manualDraft:manualRows,manualOptions}));}catch{}}
function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,5500);}
const project=()=>state?.projects.find(p=>p.id===projectId);
const conversation=()=>state?.conversations.find(c=>c.id===conversationId);
const ACTIVE=['planning','awaiting-plan','running','waiting','reviewing','integrating','queued'];
const activeRun=()=>state?.runs.find(r=>r.conversationId===conversationId&&ACTIVE.includes(r.status));
const lastRunOf=()=>state?.runs.filter(r=>r.conversationId===conversationId).at(-1);
const subtaskProvider=s=>planChoices[s.id]?.provider??s.provider;
const subtaskModel=s=>planChoices[s.id]?.model??s.model;
const subtaskEffort=s=>planChoices[s.id]?.effort??s.effort;
function scopedMemories(){return state.memories.filter(m=>!m.projectId||m.projectId===projectId);}
function openModal(title,html,type=''){ $('#modal-title').textContent=title;$('#modal-content').innerHTML=html;$('#modal').dataset.type=type;if(!$('#modal').open)$('#modal').showModal();}
function closeModal(){$('#modal').close();$('#modal').dataset.type='';}
$('#modal-close').onclick=closeModal;
$('#modal').addEventListener('click',e=>{if(e.target===$('#modal')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeModal();}});

function inline(text){
  return esc(text).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
}
function markdown(text){
  // Only a small, escaped subset is rendered. Agent HTML is always inert text.
  return String(text).split(/```/).map((part,i)=>{
    if(i%2)return '<pre><code>'+esc(part.replace(/^[\w+-]*\n/,''))+'</code></pre>';
    return part.split(/\n\s*\n/).filter(Boolean).map(block=>{
      if(/^#{1,4} /.test(block))return '<h3>'+inline(block.replace(/^#{1,4} /,''))+'</h3>';
      if(block.split('\n').every(line=>/^\s*[-*] /.test(line)))return '<ul>'+block.split('\n').map(line=>'<li>'+inline(line.replace(/^\s*[-*] /,''))+'</li>').join('')+'</ul>';
      return '<p>'+inline(block).replace(/\n/g,'<br>')+'</p>';
    }).join('');
  }).join('');
}

function welcome(){return `<div class="welcome"><div class="welcome-symbol"><span>✺</span><span>✳</span></div><div class="eyebrow">UN EQUIPO QUE SE ARMA SOLO.</div><h1>Haz espacio a<br><em>lo que quieres crear.</em></h1><p>Elige quién orquesta. Ese agente estudia la tarea, decide cuántos agentes hacen falta y qué hace cada uno; tú apruebas el plan antes de que empiecen.</p><div class="suggestions"><button class="suggestion" data-suggestion="Explora este proyecto y explícame cómo está organizado y cuál sería el siguiente paso."><span>⌁</span> Entender mi proyecto<small>Una visión clara para empezar</small></button><button class="suggestion" data-suggestion="Analiza este proyecto y propón tres mejoras concretas, reparte el trabajo entre los agentes que haga falta."><span>⇄</span> Repartir el trabajo<small>Varios frentes a la vez</small></button></div></div>`;}

function approvalHtml(a){
  const questions=a.details?.questions||[];
  const questionMode=a.kind==='question'||a.kind==='claude-question';
  return `<section class="approval" data-approval="${esc(a.id)}"><h3>${esc(a.title)}</h3>${a.label?`<div class="metadata">${esc(a.label)}</div>`:''}${questionMode?questions.map((q,i)=>`<label class="question-label"><span>${esc(q.question||q.header)}</span>${q.options?.length?`<small class="muted">${q.options.map(o=>esc(o.label)).join(' · ')}</small>`:''}<input data-answer="${i}" placeholder="Tu respuesta" autocomplete="off"></label>`).join(''):`<pre>${esc(JSON.stringify(a.details,null,2))}</pre>`}<div class="approval-actions"><button class="primary-button" data-approval-allow="${esc(a.id)}">${questionMode?'Enviar respuesta':'Permitir esta vez'}</button><button class="secondary-button" data-approval-deny="${esc(a.id)}">${questionMode?'Omitir':'Rechazar'}</button></div></section>`;
}

function renderMessages(){
  const messages=state.messages.filter(m=>m.conversationId===conversationId);
  const approvals=state.approvals.filter(a=>state.runs.find(r=>r.id===a.runId)?.conversationId===conversationId);
  const runUsage=state.runs.filter(r=>r.conversationId===conversationId).map(r=>r.usage);
  const signature=JSON.stringify([conversationId,messages,approvals,runUsage]);
  if(signature===lastMessages)return;lastMessages=signature;
  const area=$('#messages'),bottom=area.scrollHeight-area.scrollTop-area.clientHeight<130;
  area.innerHTML=(messages.length?messages.map(m=>`<article class="message ${m.role}"><div class="message-header">${m.role==='assistant'?`<span class="agent-avatar ${m.provider}">${symbols[m.provider]}</span><strong>${names[m.provider]}</strong>${m.stage?`<span class="message-stage">${esc(m.stage)}</span>`:''}`:'<strong>Tú</strong>'}<time>${new Date(m.createdAt).toLocaleTimeString('es',{hour:'2-digit',minute:'2-digit'})}</time>${usageBadges(m)}</div><div class="message-content">${m.content?markdown(m.content):m.status==='streaming'?'<span class="typing">Preparando la respuesta</span>':''}</div>${m.error?`<div class="message-error">${esc(m.error)}</div>`:''}${m.content?`<div class="message-actions"><button data-copy="${m.id}">Copiar</button>${m.role==='assistant'?`<button data-remember="${m.id}">◇ Guardar recuerdo</button>`:''}</div>`:''}</article>`).join(''):welcome())+approvals.map(approvalHtml).join('');
  if(!messages.length)area.scrollTop=0;
  else if(bottom||approvals.length||messages.length<2)area.scrollTop=area.scrollHeight;
}
const catalogOf=provider=>state.connections[provider]?.models||[];
const effortLevels=(provider,model)=>catalogOf(provider).find(m=>m.id===model)?.efforts||[];
function modelOptions(provider,selected){
  const models=catalogOf(provider);
  return models.map(m=>`<option value="${esc(m.id)}" ${m.id===selected?'selected':''}>${esc(m.name)}${m.hidden?' · oculto':''}</option>`).join('')
    +(selected&&!models.some(m=>m.id===selected)?`<option value="${esc(selected)}" selected>${esc(selected)}${models.length?' · manual':''}</option>`:'');
}
const effortOptions=(provider,model,selected)=>effortLevels(provider,model)
  .map(e=>`<option value="${e}" ${e===selected?'selected':''}>${effortNames[e]||e}</option>`).join('');
function defaultEffort(provider,model){
  const entry=catalogOf(provider).find(m=>m.id===model),levels=entry?.efforts||[];
  return levels.includes(entry?.defaultEffort)?entry.defaultEffort:levels[0]||null;
}

function renderAgents(){
  const key=JSON.stringify([state.connections,selections,efforts,orchestrator]);if(key===lastAgents)return;lastAgents=key;
  for(const p of ['codex','claude']){
    const models=catalogOf(p);
    if(models.length&&(!selections[p]||(p==='codex'&&selections[p]==='default'&&!models.some(m=>m.id==='default'))))selections[p]=(models.find(m=>m.default)||models.find(m=>!m.hidden))?.id;
    const levels=effortLevels(p,selections[p]);
    if(!levels.includes(efforts[p]))efforts[p]=defaultEffort(p,selections[p])||'';
  }
  remember();
}

// Cada fila del plan se puede reasignar al otro agente, cambiar de modelo o limitar a solo lectura.
function planRowHtml(subtask,run){
  const provider=subtaskProvider(subtask),model=subtaskModel(subtask),levels=effortLevels(provider,model);
  const readOnly=subtask.readOnly||planChoices[subtask.id]?.readOnly===true,moved=provider!==subtask.provider;
  const providers=['codex','claude'].filter(p=>p===provider||state.connections[p]?.connected);
  return `<div class="plan-row"><div class="plan-row-head"><span class="agent-avatar ${provider}">${symbols[provider]}</span><strong>${esc(subtask.title)}</strong>${readOnly?'<span class="pill">solo lectura</span>':''}${moved?'<span class="pill">reasignada</span>':''}</div>
  <div class="metadata">${esc(subtask.role)}${subtask.scope?.length?` · ${esc(subtask.scope.join(', '))}`:''}</div>
  ${subtask.justification?`<div class="metadata">${esc(subtask.justification)}</div>`:''}
  <div class="plan-row-controls"><select data-plan-provider="${esc(subtask.id)}" aria-label="Agente de ${esc(subtask.title)}">${providers.map(p=>`<option value="${p}" ${p===provider?'selected':''}>${names[p]}</option>`).join('')}</select><select data-plan-model="${esc(subtask.id)}" aria-label="Modelo de ${esc(subtask.title)}">${modelOptions(provider,model)}</select>
  ${levels.length?`<select data-plan-effort="${esc(subtask.id)}" aria-label="Razonamiento de ${esc(subtask.title)}">${effortOptions(provider,model,subtaskEffort(subtask))}</select>`:''}${!subtask.readOnly&&!run?.readOnly?`<label class="readonly-control"><input type="checkbox" data-plan-readonly="${esc(subtask.id)}" ${readOnly?'checked':''}> Solo lectura</label>`:''}</div></div>`;
}

function planHtml(run){
  const writers=run.subtasks.filter(s=>!s.readOnly).length;
  // Una sola sub-tarea que escribe trabaja en la carpeta real: solo dos o más necesitan copias aisladas.
  const needsGit=writers>1&&run.isolation?.kind!=='worktree';
  return `<div class="plan-card"><div class="plan-head"><strong>Plan propuesto</strong><span class="pill">${run.subtasks.length} sub-tarea${run.subtasks.length===1?'':'s'}</span></div>
  ${run.plan.summary?`<p class="muted">${esc(run.plan.summary)}</p>`:''}
  ${run.plan.status==='fallback'?'<div class="message-error">El orquestador no devolvió un plan legible; se ejecutará tu petición con un solo agente.</div>':''}
  ${(run.plan.warnings||[]).map(w=>`<div class="metadata">⚠ ${esc(w)}</div>`).join('')}
  ${run.plan.context?`<details class="plan-context"><summary>Contexto que recibirán todas las sub-tareas</summary><p class="muted">${esc(run.plan.context)}</p></details>`:''}
  ${run.subtasks.map(s=>planRowHtml(s,run)).join('')}
  ${needsGit?`<div class="plan-git"><div class="metadata">Esta carpeta no es un repositorio git: sin eso, varias sub-tareas no pueden escribir a la vez sobre copias aisladas.</div>
    <label><input type="radio" name="plan-git" value="serial" ${initRepo?'':'checked'}> Ejecutar las escrituras de una en una (no cambia tu carpeta)</label>
    <label><input type="radio" name="plan-git" value="init" ${initRepo?'checked':''}> Convertirla en repositorio git para trabajar en paralelo</label></div>`:''}
  <div class="approval-actions"><button class="primary-button" id="plan-approve">Empezar</button><button class="secondary-button" id="plan-reject">Descartar</button></div></div>`;
}

function teamHtml(run){
  const opened=new Set([...document.querySelectorAll('#run-status details[open]')].map(d=>d.dataset.subtask));
  const done=run.subtasks.filter(s=>['completed','error','cancelled','stopped'].includes(s.status)).length;
  return `<div class="plan-card"><div class="plan-head"><strong>${esc(run.stage||'Trabajando')}</strong><span>${run.usage?.total?`<span class="pill" title="Consumo acumulado de la tarea">${usageText(run.usage)}</span> `:''}${run.subtasks.length?`<span class="pill">${done}/${run.subtasks.length}</span>`:''}</span></div>
  ${run.subtasks.length?run.subtasks.map(s=>`<details data-subtask="${esc(s.id)}" ${opened.has(s.id)?'open':''}><summary><span class="agent-avatar ${s.provider}">${symbols[s.provider]}</span> ${esc(s.title)} · ${esc(names[s.provider])} ${esc(s.model)} <span class="muted">· ${esc(stageNames[s.status]||s.stage||'')}</span>${s.usage?.total?`<span class="muted"> · ${fmtTokens(s.usage.total)}</span>`:''}</summary><div class="run-events">${s.events.map(e=>esc(e.text)).join('\n')||(s.status==='queued'?'En espera de su turno.':'Trabajando…')}</div>${s.error?`<div class="message-error">${esc(s.error)}</div>`:''}</details>`).join('')
    :`<div class="run-events">${run.events.map(e=>esc(e.text)).join('\n')||'Conectando con la sesión local…'}</div>`}
  ${(run.isolation?.warnings||[]).map(w=>`<div class="metadata">⚠ ${esc(w)}</div>`).join('')}</div>`;
}

// Corregir reanuda la sesión de esa sub-tarea con la revisión del arquitecto; no replanifica ni repite las demás.
function fixFormHtml(run,open){
  const fixable=run.subtasks.filter(s=>s.fixable);
  if(!fixable.length)return '';
  const form=`<div class="fix-form"><label class="form-field compact-field"><span>Sub-tarea a corregir</span><select id="fix-subtask">${fixable.map(s=>`<option value="${esc(s.id)}">#${s.index+1} ${esc(s.title)} · ${esc(names[s.provider])} ${esc(s.model)}</option>`).join('')}</select></label><label class="form-field"><span>Indicaciones (opcional; la revisión del arquitecto se incluye siempre)</span><textarea id="fix-feedback" rows="2" maxlength="8000" placeholder="Qué debe cambiar"></textarea></label><div class="approval-actions"><button type="button" class="primary-button" id="fix-run">Corregir sin replanificar</button></div></div>`;
  return open?form:`<details class="fix-details"><summary>Corregir una sub-tarea sin replanificar</summary>${form}</details>`;
}
function afterRunHtml(run){
  const integration=run.review?.integration,conflicts=integration?.conflicts||[];
  const pending=!!run.review&&run.subtasks.some(s=>s.patch)&&!integration?.applied?.length&&!integration?.discarded;
  const rejected=run.review?.status==='no-integrar';
  const fixable=run.subtasks.some(s=>s.fixable);
  if(!pending&&!rejected)return fixable?`<div class="after-run">${run.usage?.total?`<span class="pill" title="Consumo total de la tarea">${usageText(run.usage)} · ${run.usage.turns} turnos</span>`:''}${fixFormHtml(run,false)}</div>`:'';
  return `<div class="plan-card"><div class="plan-head"><strong>${pending?'Cambios sin integrar':'El revisor no autorizó la integración'}</strong>${run.usage?.total?`<span class="pill" title="Consumo total de la tarea">${usageText(run.usage)} · ${run.usage.turns} turnos</span>`:''}</div>
  ${conflicts.map(c=>`<div class="metadata">${esc(c.file)}: ${esc(c.reason)}</div>`).join('')}
  ${pending?'<p class="muted">El trabajo de los agentes está guardado aparte; tu carpeta no se tocó.</p>':'<p class="muted">Los cambios ya están en tu carpeta; lee la revisión antes de darlos por buenos.</p>'}
  ${fixFormHtml(run,true)}
  ${pending?`<div class="approval-actions"><button class="primary-button" id="integrate-apply">Aplicar cambios</button><button class="secondary-button" id="integrate-discard">Descartar</button></div>`:''}</div>`;
}

function renderRun(){
  const run=activeRun()||lastRunOf(),status=$('#run-status');
  const signature=JSON.stringify([run?.id,run?.status,run?.stage,run?.plan,run?.isolation,run?.review?.status,run?.review?.integration,run?.error,run?.usage,
    (run?.subtasks||[]).map(s=>[s.id,s.status,s.stage,s.model,s.effort,s.events.length,s.error,s.fixable,s.usage?.total]),run?.events.length,planChoices,initRepo]);
  if(signature===lastRun)return;lastRun=signature;
  if(!run){status.hidden=true;status.innerHTML='';return;}
  if(run.status==='awaiting-plan'){status.hidden=false;status.innerHTML=planHtml(run);return;}
  if(ACTIVE.includes(run.status)){status.hidden=false;status.innerHTML=teamHtml(run);return;}
  const html=(run.error?`<div class="run-error">${esc(run.error)}</div>`:'')+afterRunHtml(run);
  status.hidden=!html;status.innerHTML=html;
}
function renderMemory(){
  const sync=state.memorySync||{state:'pending'};
  const label={pending:'Engram · pendiente',syncing:'Engram · sincronizando',synced:'Engram · sincronizado',offline:'Engram · respaldo local'}[sync.state]||'Engram · pendiente';
  $('.local-note').textContent=label;
  $('.local-note').title=sync.error||`Última sincronización: ${sync.lastSuccess?new Date(sync.lastSuccess).toLocaleString('es'):'pendiente'}. El historial se conserva localmente.`;
  $('.local-note').setAttribute('role','status');
  if($('#memory-sync-status'))$('#memory-sync-status').textContent=label+(sync.error?' · '+sync.error:'');
  const memories=scopedMemories();const key=JSON.stringify(memories);if(key===lastMemory)return;lastMemory=key;
  $('#memory-count').textContent=memories.length;
}
// Reparto a mano: las filas se guardan como borrador y su estructura solo se vuelve a pintar cuando
// cambia (agente, modelo, añadir o quitar), nunca mientras se escribe, para no perder el foco.
function defaultModel(provider){return (catalogOf(provider).find(m=>m.default)||catalogOf(provider).find(m=>!m.hidden))?.id||'';}
function newManualRow(provider){const model=defaultModel(provider);return {title:'',provider,model,effort:defaultEffort(provider,model)||'',instructions:'',scope:'',readOnly:false};}
function seedManualRows(){manualRows=[newManualRow('codex'),newManualRow('claude')];manualVersion++;}
function manualRowHtml(row,i){
  const levels=effortLevels(row.provider,row.model);
  return `<div class="manual-row" data-row="${i}"><div class="manual-row-head"><span class="agent-avatar ${row.provider}">${symbols[row.provider]}</span><input data-field="title" placeholder="Sub-tarea ${i+1}: título" maxlength="120" value="${esc(row.title||'')}" aria-label="Título de la sub-tarea ${i+1}"><button type="button" class="icon-button" data-remove="${i}" aria-label="Quitar sub-tarea ${i+1}">×</button></div>
  <div class="manual-row-grid"><select data-field="provider" aria-label="Agente">${['codex','claude'].map(p=>`<option value="${p}" ${p===row.provider?'selected':''}>${names[p]}${state?.connections[p]?.connected?'':' · sin conexión'}</option>`).join('')}</select><select data-field="model" aria-label="Modelo">${modelOptions(row.provider,row.model)}</select>${levels.length?`<select data-field="effort" aria-label="Razonamiento">${effortOptions(row.provider,row.model,row.effort)}</select>`:''}<input data-field="scope" placeholder="Alcance: rutas separadas por comas (opcional)" value="${esc(row.scope||'')}" aria-label="Alcance"><label class="readonly-control"><input type="checkbox" data-field="readOnly" ${row.readOnly?'checked':''}> Solo lectura</label></div>
  <textarea data-field="instructions" rows="2" maxlength="12000" placeholder="Qué debe hacer, con detalle suficiente para trabajar sin verte" aria-label="Instrucciones de la sub-tarea ${i+1}">${esc(row.instructions||'')}</textarea></div>`;
}
function renderManual(){
  const panel=$('#manual-panel');panel.hidden=mode!=='manual';
  if(panel.hidden)return;
  const key=JSON.stringify([manualVersion,orchestrator,state?.connections,manualOptions]);if(key===lastManual)return;lastManual=key;
  panel.innerHTML=`<div class="manual-head"><strong>Reparto a mano</strong><span class="muted">Arriba, el objetivo de la tarea; aquí, quién hace cada parte. Hasta 8 sub-tareas; las que escriben sobre archivos distintos trabajan a la vez.</span></div>${manualRows.map(manualRowHtml).join('')}<div class="manual-actions"><button type="button" class="secondary-button" id="manual-add">＋ Sub-tarea</button><label class="readonly-control"><input type="checkbox" id="manual-review" ${manualOptions.review!==false?'checked':''}> ${names[orchestrator]} revisa al terminar</label><label class="readonly-control"><input type="checkbox" id="manual-git" ${manualOptions.initRepo?'checked':''}> Convertir la carpeta en repositorio git si hace falta para trabajar en paralelo</label></div>`;
}
$('#manual-panel').oninput=e=>{
  const rowEl=e.target.closest('[data-row]');if(!rowEl)return;
  const row=manualRows[Number(rowEl.dataset.row)],field=e.target.dataset.field;if(!row||!field)return;
  row[field]=e.target.type==='checkbox'?e.target.checked:e.target.value;
  remember();
};
$('#manual-panel').onchange=e=>{
  if(e.target.id==='manual-review'){manualOptions.review=e.target.checked;remember();return;}
  if(e.target.id==='manual-git'){manualOptions.initRepo=e.target.checked;remember();return;}
  const rowEl=e.target.closest('[data-row]');if(!rowEl)return;
  const row=manualRows[Number(rowEl.dataset.row)],field=e.target.dataset.field;if(!row||!field)return;
  if(field==='provider'){row.provider=e.target.value;row.model=defaultModel(row.provider);row.effort=defaultEffort(row.provider,row.model)||'';}
  else if(field==='model'){row.model=e.target.value;row.effort=defaultEffort(row.provider,row.model)||'';}
  else return;
  manualVersion++;remember();renderManual();
};
$('#manual-panel').onclick=e=>{
  if(e.target.id==='manual-add'){if(manualRows.length>=8){toast('Como máximo 8 sub-tareas por tarea.');return;}manualRows.push(newManualRow(manualRows.length%2?'claude':'codex'));manualVersion++;remember();renderManual();return;}
  const remove=e.target.closest('[data-remove]');if(remove){manualRows.splice(Number(remove.dataset.remove),1);manualVersion++;remember();renderManual();}
};
function render(){
  if(!state.projects.some(p=>p.id===projectId))projectId=state.projects[0]?.id;
  if(!state.conversations.some(c=>c.id===conversationId&&c.projectId===projectId))conversationId=null;
  const select=$('#project-select');if(document.activeElement!==select)select.innerHTML=state.projects.map(p=>`<option value="${p.id}" ${p.id===projectId?'selected':''}>${esc(p.name)}</option>`).join('');
  $('#project-folder').textContent=project()?.path||'';$('#project-folder').title=project()?.path||'';
  const quota=quotaText('codex');$('#quota-hint').textContent=quota?`Codex: ${quota}`:'';
  $('#project-name').textContent=project()?.name||'';$('#conversation-title').textContent=conversation()?.title||'Nueva conversación';
  $('#conversations').innerHTML=state.conversations.filter(c=>c.projectId===projectId).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(c=>`<button class="conversation-link ${c.id===conversationId?'active':''}" data-conversation="${c.id}"><span>◷</span><span>${esc(c.title)}</span></button>`).join('');
  renderAgents();renderMemory();renderMessages();renderRun();renderManual();
  const run=activeRun();
  $('#send').hidden=!!run;$('#cancel-run').hidden=!run;$('#send').disabled=busy;
  updateOrchestrator();remember();
}
function updateOrchestrator(){
  const auto=state?.settings?.autoApproveSingle||state?.settings?.autoApproveReadOnly;
  const hints={
    orquestar:`${names[orchestrator]} orquesta: ${auto?'los planes sencillos empiezan solos según tus ajustes':'verás el plan antes de que empiece nadie'}. Las preguntas se responden sin plan.`,
    directo:`${names[orchestrator]} en directo: un solo agente con sesión continua, sin plan ni revisión. Para trabajo iterativo.`,
    manual:`Reparto a mano: tú decides las sub-tareas y quién hace cada una. ${names[orchestrator]} revisa al final si lo marcas.`
  };
  $('#mode-hint').textContent=hints[mode]||hints.orquestar;
  $('#orchestrator-symbol').textContent=symbols[orchestrator];
  const select=$('#orchestrator');if(select.value!==orchestrator)select.value=orchestrator;
  const modeSelect=$('#mode');if(modeSelect.value!==mode)modeSelect.value=mode;
  $('#prompt').placeholder=mode==='manual'?'Objetivo de la tarea: qué hay que conseguir en conjunto':mode==='directo'?`Habla con ${names[orchestrator]}`:'¿Qué vamos a hacer?';
}
async function load(){
  try{state=await api('state');$('#connection-error').hidden=true;render();}catch(e){$('#connection-error').hidden=false;}
}
$('#reload').onclick=()=>location.reload();
$('#project-select').onchange=e=>{projectId=e.target.value;conversationId=null;lastMessages='';render();};
$('#conversations').onclick=e=>{const b=e.target.closest('[data-conversation]');if(b){conversationId=b.dataset.conversation;lastMessages='';render();}};
$('#new-conversation').onclick=()=>{conversationId=null;lastMessages='';render();$('#prompt').focus();};
$('#orchestrator').onchange=e=>{orchestrator=e.target.value;lastAgents='';renderAgents();updateOrchestrator();lastManual='';renderManual();remember();};
$('#mode').onchange=e=>{mode=e.target.value;if(mode==='manual'&&!manualRows.length)seedManualRows();updateOrchestrator();lastManual='';renderManual();remember();};

$('#run-status').onchange=e=>{
  const run=activeRun();if(!run)return;
  if(e.target.name==='plan-git'){initRepo=e.target.value==='init';lastRun='';renderRun();return;}
  const {planModel,planEffort,planProvider,planReadonly}=e.target.dataset;
  const id=planModel||planEffort||planProvider||planReadonly;if(!id)return;
  const subtask=run.subtasks.find(s=>s.id===id);if(!subtask)return;
  const current=planChoices[id]||{};
  if(planProvider){
    // Al reasignar, el modelo y el nivel pasan a los predeterminados del otro agente.
    const provider=e.target.value,model=defaultModel(provider);
    planChoices[id]={...current,provider,model,effort:defaultEffort(provider,model)};
  } else if(planModel){
    // Al cambiar de modelo, el nivel anterior puede no existir en el nuevo: se reajusta al predeterminado.
    planChoices[id]={...current,model:e.target.value,effort:defaultEffort(subtaskProvider(subtask),e.target.value)};
  } else if(planEffort)planChoices[id]={...current,effort:e.target.value};
  else planChoices[id]={...current,readOnly:e.target.checked};
  lastRun='';renderRun();
};

$('#run-status').onclick=async e=>{
  const run=activeRun()||lastRunOf();if(!run||!e.target.id)return;
  const act=async(route,body,done)=>{try{const result=await api(route,body);planChoices={};initRepo=false;lastRun='';await load();if(done)done(result);}catch(error){toast(error.message);}};
  if(e.target.id==='plan-approve')await act('plan',{runId:run.id,approve:true,initRepo,
    subtasks:run.subtasks.map(s=>({id:s.id,provider:subtaskProvider(s),model:subtaskModel(s),effort:subtaskEffort(s)||null,readOnly:planChoices[s.id]?.readOnly===true}))});
  if(e.target.id==='plan-reject')await act('plan',{runId:run.id,approve:false});
  if(e.target.id==='integrate-apply')await act('integrate',{runId:run.id},result=>
    toast(result.conflicts?.length?'No se pudo integrar: sigue habiendo conflictos.':'Cambios integrados en tu carpeta.'));
  if(e.target.id==='integrate-discard')await act('integrate',{runId:run.id,discard:true},()=>toast('Copias de trabajo descartadas.'));
  if(e.target.id==='fix-run'){
    const subtaskId=$('#fix-subtask')?.value,feedback=$('#fix-feedback')?.value.trim()||'';
    if(subtaskId)await act('fix',{runId:run.id,subtaskId,feedback},()=>toast('Corrección en marcha; el arquitecto volverá a revisar al terminar.'));
  }
};
$('#composer').onsubmit=async e=>{
  e.preventDefault();if(busy||activeRun())return;
  const input=$('#prompt'),prompt=input.value.trim();if(!prompt)return;
  if(!projectId){toast('Crea o añade un proyecto antes de empezar.');return;}
  const body={prompt,readOnly:$('#read-only').checked,mode,orchestrator:{provider:orchestrator,model:selections[orchestrator],effort:efforts[orchestrator]||null}};
  if(mode==='manual'){
    const rows=manualRows.map(r=>({title:(r.title||'').trim(),provider:r.provider,model:r.model,effort:r.effort||null,instructions:(r.instructions||'').trim(),scope:r.scope||'',readOnly:!!r.readOnly}));
    if(!rows.length||rows.some(r=>!r.title||!r.instructions)){toast('Cada sub-tarea necesita título e instrucciones.');return;}
    body.plan={subtasks:rows,review:manualOptions.review!==false,initRepo:!!manualOptions.initRepo};
  }
  if((mode!=='manual'||manualOptions.review!==false)&&!selections[orchestrator]){toast(`Conecta ${names[orchestrator]} desde Agentes antes de empezar.`);return;}
  busy=true;$('#send').disabled=true;
  try{
    if(!conversationId){const c=await api('conversations',{projectId});conversationId=c.id;}
    planChoices={};initRepo=false;lastRun='';
    body.conversationId=conversationId;
    await api('run',body);
    if(mode==='manual'){seedManualRows();lastManual='';}
    input.value='';input.style.height='';lastMessages='';remember();await load();$('#messages').scrollTop=$('#messages').scrollHeight;
  }catch(error){toast(error.message);await load();}finally{busy=false;$('#send').disabled=false;}
};
$('#prompt').onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();$('#composer').requestSubmit();}};
$('#prompt').oninput=e=>{e.target.style.height='auto';e.target.style.height=Math.min(e.target.scrollHeight,220)+'px';};
$('#cancel-run').onclick=async()=>{try{await api('cancel',{id:activeRun().id});await load();}catch(e){toast(e.message);}};
$('#messages').onclick=async e=>{
  const suggestion=e.target.closest('[data-suggestion]');if(suggestion){$('#prompt').value=suggestion.dataset.suggestion;$('#prompt').focus();return;}
  const copy=e.target.closest('[data-copy]');if(copy){try{await navigator.clipboard.writeText(state.messages.find(m=>m.id===copy.dataset.copy).content);toast('Respuesta copiada.');}catch{toast('No se pudo copiar. Selecciona el texto y cópialo.');}return;}
  const save=e.target.closest('[data-remember]');if(save){const m=state.messages.find(m=>m.id===save.dataset.remember);memoryForm({title:'Nota de '+names[m.provider],content:m.content.slice(0,12000)});return;}
  const approve=e.target.closest('[data-approval-allow]'),deny=e.target.closest('[data-approval-deny]');
  if(approve||deny){
    const key=approve?.dataset.approvalAllow||deny.dataset.approvalDeny;
    const a=state.approvals.find(a=>a.id===key),answers={};
    if(approve&&(a.kind==='question'||a.kind==='claude-question')){
      const inputs=[...document.querySelectorAll(`[data-approval="${key}"] [data-answer]`)];
      if(inputs.some(i=>!i.value.trim())){toast('Escribe una respuesta para cada pregunta.');return;}
      (a.details.questions||[]).forEach((q,i)=>{if(a.kind==='question')answers[q.id]={answers:[inputs[i].value]};else answers[q.question]=inputs[i].value;});
    }
    try{await api('approvals/'+key,{allow:!!approve,answers});await load();}catch(error){toast(error.message);}
  }
};

$('#new-project').onclick=()=>{
  const managed=state.app.projectsRoot;
  if(!managed.available){openModal('Carpeta de proyectos no disponible',`<p class="modal-note">Crea esta carpeta fuera del repositorio de Mixto y vuelve a abrir la aplicación:</p><p><code>${esc(managed.path)}</code></p><p class="modal-note">Mixto detectará automáticamente cada carpeta de proyecto que haya dentro.</p>`);return;}
  openModal('Crear proyecto',`<form id="project-form"><label class="form-field"><span>Nombre</span><input name="name" required maxlength="80" placeholder="Paper shop POS" autofocus></label><label class="form-field"><span>Nombre de carpeta</span><input name="directoryName" required maxlength="80" pattern="[A-Za-z0-9][A-Za-z0-9._-]*" placeholder="tpv-papeleria"><small>Se creará dentro de ${esc(managed.path)}. Las carpetas que ya existan ahí se detectan automáticamente.</small></label><label class="form-field"><span>Descripción (opcional)</span><textarea name="description" rows="2" maxlength="2000"></textarea></label><div class="form-footer"><button class="primary-button">Crear proyecto</button></div></form>`);
  $('#project-form').onsubmit=async e=>{e.preventDefault();try{const p=await api('projects',Object.fromEntries(new FormData(e.target)));projectId=p.id;conversationId=null;closeModal();await load();toast('Proyecto añadido.');}catch(error){toast(error.message);}};
};

function memoryForm(existing={}){
  openModal(existing.id?'Editar recuerdo':'Añadir un recuerdo',`<form id="memory-form"><label class="form-field"><span>Título</span><input name="title" required maxlength="100" value="${esc(existing.title||'')}" placeholder="Una preferencia, una decisión…"></label><label class="form-field"><span>Qué deben recordar los dos agentes</span><textarea name="content" required rows="7" maxlength="12000" placeholder="Por ejemplo: este proyecto usa TypeScript y prefiero explicaciones breves.">${esc(existing.content||'')}</textarea></label>${!existing.id?`<label class="form-field"><span>Disponible en</span><select name="scope">${project()?`<option value="project">${esc(project().name)}</option>`:''}<option value="global">Todos mis proyectos</option></select></label>`:''}<div class="form-footer"><button class="primary-button">Guardar recuerdo</button></div></form>`);
  $('#memory-form').onsubmit=async e=>{e.preventDefault();const values=Object.fromEntries(new FormData(e.target));try{if(existing.id)await api('memories/'+existing.id,values,'PATCH');else await api('memories',{...values,projectId:values.scope==='global'?null:projectId});closeModal();await load();toast('Recuerdo guardado para los dos agentes.');}catch(error){toast(error.message);}};
}
function memoryList(){
  openModal('Memoria compartida',`<p class="modal-note">Los recuerdos que guardas tienen prioridad. Los registros de trabajo se guardan automáticamente y se recuperan por relevancia y fecha. El historial completo permanece en tus conversaciones.</p><div class="memory-toolbar"><input id="memory-search" placeholder="Buscar en la memoria" aria-label="Buscar en la memoria"><button class="primary-button" id="memory-create">＋ Recuerdo</button></div><div id="memory-records"></div><div class="form-footer"><a href="/api/export" download="mixto-copia.json" class="text-button">Descargar copia de mis datos ↗</a></div>`,'memory');
  const status=document.createElement('p');status.id='memory-sync-status';status.className='modal-note';status.setAttribute('role','status');
  const retry=document.createElement('button');retry.className='secondary-button';retry.textContent='Sincronizar con Engram';retry.onclick=async()=>{try{await api('memory-sync',{});await load();}catch(error){toast(error.message);}};
  $('#modal-content').prepend(status,retry);renderMemory();
  const draw=()=>{
    const q=$('#memory-search').value.toLocaleLowerCase();
    const records=scopedMemories().filter(m=>(m.title+' '+m.content).toLocaleLowerCase().includes(q)).reverse();
    $('#memory-records').innerHTML=records.length?records.map(m=>`<article class="memory-record"><header><h3>${esc(m.title)}</h3><span class="pill">${m.automatic?'Registro automático':'Recuerdo'}</span></header><div class="metadata">${m.projectId?'Este proyecto':'Todos los proyectos'} · ${new Date(m.createdAt).toLocaleDateString('es')}</div><p>${esc(m.content)}</p><footer>${m.conversationId?`<button class="secondary-button" data-memory-open="${m.conversationId}">Conversación</button>`:''}<button class="secondary-button" data-memory-edit="${m.id}">${m.automatic?'Convertir en recuerdo':'Editar'}</button><button class="danger-button" data-memory-delete="${m.id}">Eliminar</button></footer></article>`).join(''):'<div class="memory-empty">No hay recuerdos que coincidan.</div>';
    for(const memory of scopedMemories().filter(m=>m.engramReadOnly)){
    const edit=$(`[data-memory-edit="${memory.id}"]`),remove=$(`[data-memory-delete="${memory.id}"]`);
    if(edit){edit.disabled=true;edit.textContent=memory.needsReview?'Engram · pendiente de revisión':'Gestionado en Engram';}
    if(remove)remove.disabled=true;
    }
  };
  draw();$('#memory-search').oninput=draw;$('#memory-create').onclick=()=>memoryForm();
  $('#memory-records').onclick=async e=>{
    const b=e.target.closest('button');if(!b)return;
    if(b.dataset.memoryEdit)memoryForm(state.memories.find(m=>m.id===b.dataset.memoryEdit));
    if(b.dataset.memoryOpen){conversationId=b.dataset.memoryOpen;closeModal();render();}
    if(b.dataset.memoryDelete){try{await api('memories/'+b.dataset.memoryDelete,{},'DELETE');await load();draw();toast('Recuerdo eliminado.');}catch(error){toast(error.message);}}
  };
}
$('#open-memory').onclick=memoryList;
function connectionsModal(){
  openModal('Agentes',`<p class="modal-note">Mixto usa las sesiones de las herramientas instaladas. Aquí solo configuras lo necesario para orquestar.</p>${['codex','claude'].map(p=>{const c=state.connections[p],levels=effortLevels(p,selections[p]);return `<section class="connection-card"><h3><span class="agent-avatar ${p}">${symbols[p]}</span> ${names[p]}</h3><p>${c.loading?'Consultando conexión…':c.connected?'Conectado · '+esc(c.plan||c.authType):'Sin conexión'}</p>${limitsHtml(p,c)}${c.error?`<div class="message-error">${esc(c.error)}</div>`:''}${!c.connected?`<p>Inicia sesión con <code>${p==='codex'?'codex login':'claude auth login'}</code> y pulsa Actualizar.</p>`:''}${c.models.length?`<label class="form-field compact-field"><span>Modelo predeterminado</span><select data-agent-model="${p}">${modelOptions(p,selections[p])}</select><small>Cuando ${names[p]} orquesta, este modelo planifica y revisa: uno rápido abarata cada tarea. Los modelos potentes se eligen por sub-tarea en el plan.</small></label>${levels.length?`<label class="form-field compact-field"><span>Razonamiento</span><select data-agent-effort="${p}">${effortOptions(p,selections[p],efforts[p])}</select></label>`:''}`:''}</section>`;}).join('')}<form id="agent-settings"><label class="form-field"><span>Persona del arquitecto</span><select name="orchestratorPersona"><option value="">Sin persona</option>${state.personas.map(p=>`<option value="${esc(p.id)}" ${p.id===state.settings.orchestratorPersona?'selected':''}>${esc(p.name)}</option>`).join('')}</select><small>Añade unos 7.000 tokens de texto genérico a cada plan. Déjala en «Sin persona» salvo que la necesites.</small></label><label class="check-field"><input type="checkbox" name="autoApproveSingle" ${state.settings.autoApproveSingle?'checked':''}> Empezar sin pedir aprobación cuando el plan tiene una sola sub-tarea</label><label class="check-field"><input type="checkbox" name="autoApproveReadOnly" ${state.settings.autoApproveReadOnly?'checked':''}> Empezar sin pedir aprobación cuando todas las sub-tareas son de solo lectura</label><label class="form-field"><span>Tope de tokens por tarea (0 = sin tope)</span><input type="number" name="tokenBudget" min="0" step="1000" value="${Number(state.settings.tokenBudget)||0}"><small>Se comprueba al cerrar cada turno, así que puede excederse por un turno. Al superarlo la tarea se detiene y te lo dice; una corrección la reanuda.</small></label>${['codex','claude'].map(p=>`<label class="form-field"><span>Preferencias para ${names[p]}</span><textarea name="${p}Instructions" rows="3" maxlength="8000" placeholder="Cómo quieres que trabaje este agente…">${esc(state.settings[p+'Instructions'])}</textarea></label>`).join('')}<div class="form-footer"><button type="button" class="secondary-button" id="refresh-connections">Actualizar</button><button class="primary-button">Guardar</button></div></form>`,'connections');
  $('#modal-content').onchange=e=>{
    const model=e.target.dataset.agentModel,effort=e.target.dataset.agentEffort;
    if(model){selections[model]=e.target.value;efforts[model]=defaultEffort(model,e.target.value)||'';lastAgents='';renderAgents();connectionsModal();}
    if(effort){efforts[effort]=e.target.value;remember();}
  };
  $('#agent-settings').onsubmit=async e=>{e.preventDefault();const form=new FormData(e.target);
    // Una casilla sin marcar no viaja en FormData: los booleanos se envían explícitamente.
    const body={orchestratorPersona:form.get('orchestratorPersona')||'',codexInstructions:form.get('codexInstructions')||'',claudeInstructions:form.get('claudeInstructions')||'',autoApproveSingle:form.has('autoApproveSingle'),autoApproveReadOnly:form.has('autoApproveReadOnly'),tokenBudget:Number(form.get('tokenBudget'))||0};
    try{await api('settings',body);await load();toast('Preferencias guardadas.');}catch(error){toast(error.message);}};
  $('#refresh-connections').onclick=async()=>{
    const button=$('#refresh-connections');button.disabled=true;button.textContent='Consultando…';
    try{await api('connections',{});await load();let attempts=0;while(Object.values(state.connections).some(c=>c.loading)&&attempts++<50){await new Promise(r=>setTimeout(r,1000));await load();}if($('#modal').open&&$('#modal').dataset.type==='connections')connectionsModal();}catch(error){toast(error.message);button.disabled=false;}
  };
}
$('#open-connections').onclick=connectionsModal;
document.addEventListener('keydown',e=>{if(e.key.toLowerCase()==='n'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)&&!$('#modal').open){e.preventDefault();$('#new-conversation').click();}});

const webContext=document.modelContext;
if(webContext?.registerTool){
  try{Promise.resolve(webContext.registerTool({name:'read_mixto_project_memory',title:'Consultar memoria de Mixto',description:'Lee los recuerdos guardados del proyecto seleccionado en Mixto. No ejecuta agentes ni modifica datos.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:input=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new Error('No se admiten parámetros.');if(!state)throw new Error('Mixto aún está cargando.');if(!project())throw new Error('No hay ningún proyecto seleccionado.');return {project:project().name,memories:scopedMemories().map(m=>({title:m.title,content:m.content,automatic:m.automatic}))};}})).catch(()=>{});}catch{}
}
// El servidor empuja el estado por SSE en cuanto cambia; el sondeo queda solo como red de seguridad
// cuando la conexión de eventos no está abierta, y para detectar que la app se ha cerrado.
let events=null;
function connectEvents(){
  try{events=new EventSource('/api/events');}catch{events=null;return;}
  events.addEventListener('state',e=>{try{state=JSON.parse(e.data);$('#connection-error').hidden=true;render();}catch{}});
  events.onerror=()=>{setTimeout(()=>{if(events?.readyState!==1)load();},1500);};
}
load();connectEvents();
setInterval(()=>{if(!document.hidden&&(!events||events.readyState!==1))load();},5000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});
