const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={codex:'Codex',claude:'Claude Code'};
const symbols={codex:'✳',claude:'✺'};
const effortNames={low:'Ligero',medium:'Equilibrado',high:'Alto',xhigh:'Muy alto',max:'Máximo',ultra:'Ultra'};
const stageNames={queued:'En espera',running:'Trabajando',waiting:'Esperando tu respuesta',completed:'Completado',error:'Sin completar',cancelled:'Detenido',stopped:'Detenida por el arquitecto',interrupted:'Interrumpido',pendiente:'Pendiente','en-curso':'En curso',hecha:'Hecha'};
// Personas reales del equipo: se les asignan sub-tareas que Mixto no ejecuta; tú anotas su estado.
const HUMAN='persona';
const humanStatuses=[['pendiente','Pendiente'],['en-curso','En curso'],['hecha','Hecha']];
const peopleOf=p=>state?state.people.filter(person=>(p?.members||[]).includes(person.id)):[];
const personName=s=>state?.people.find(p=>p.id===s.personId)?.name||s.personName||'persona';
const assigneeLabel=s=>s.human?`${personName(s)} · persona`:`${names[s.provider]} ${s.model}`;
const avatar=s=>s.human?'<span class="agent-avatar human" title="Persona del equipo">👤</span>':`<span class="agent-avatar ${s.provider}">${symbols[s.provider]}</span>`;
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
let attachments=[],notifyEnabled=false,terminalOpen=false,lastTerminal='',conversationQuery='';
const lastRunStates=new Map();
const statusLabel={added:'nuevo',modified:'modificado',deleted:'eliminado',renamed:'renombrado',untracked:'nuevo'};
let preferences;try{preferences=JSON.parse(localStorage.getItem('mixto-preferences')||'{}');}catch{preferences={};}
const selections=preferences.models||{},efforts=preferences.efforts||{};
projectId=preferences.projectId;conversationId=preferences.conversationId;
if(['codex','claude'].includes(preferences.orchestrator))orchestrator=preferences.orchestrator;
if(['orquestar','directo','manual'].includes(preferences.mode))mode=preferences.mode;
if(Array.isArray(preferences.manualDraft))manualRows=preferences.manualDraft.filter(r=>r&&typeof r==='object');
if(preferences.manualOptions&&typeof preferences.manualOptions==='object')manualOptions={...manualOptions,...preferences.manualOptions};
notifyEnabled=preferences.notify===true;terminalOpen=preferences.terminalOpen===true;

async function api(route,body,method=body===undefined?'GET':'POST'){
  const response=await fetch('/api/'+route,{method,headers:body===undefined?{}:{'Content-Type':'application/json','X-Mixto-Client':'1'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'No se pudo completar la acción.');return data;
}
function remember(){try{localStorage.setItem('mixto-preferences',JSON.stringify({projectId,conversationId,orchestrator,mode,models:selections,efforts,manualDraft:manualRows,manualOptions,notify:notifyEnabled,terminalOpen}));}catch{}}
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
  return `<section class="approval" data-approval="${esc(a.id)}"><h3>${esc(a.title)}</h3>${a.label?`<div class="metadata">${esc(a.label)}</div>`:''}${questionMode?questions.map((q,i)=>`<label class="question-label"><span>${esc(q.question||q.header)}</span>${q.options?.length?`<small class="muted">${q.options.map(o=>esc(o.label)).join(' · ')}</small>`:''}<input data-answer="${i}" placeholder="Tu respuesta" autocomplete="off"></label>`).join(''):a.command?`<pre class="command">${esc(a.command)}</pre>`:`<pre>${esc(JSON.stringify(a.details,null,2))}</pre>`}<div class="approval-actions"><button class="primary-button" data-approval-allow="${esc(a.id)}">${questionMode?'Enviar respuesta':'Permitir esta vez'}</button>${a.command?`<button class="secondary-button" data-approval-always="${esc(a.id)}" title="Guarda el prefijo del comando en la lista de comandos permitidos del proyecto">Permitir siempre en este proyecto</button>`:''}<button class="secondary-button" data-approval-deny="${esc(a.id)}">${questionMode?'Omitir':'Rechazar'}</button></div></section>`;
}

function renderMessages(){
  const messages=state.messages.filter(m=>m.conversationId===conversationId);
  const approvals=state.approvals.filter(a=>state.runs.find(r=>r.id===a.runId)?.conversationId===conversationId);
  const runUsage=state.runs.filter(r=>r.conversationId===conversationId).map(r=>[r.usage,r.phase,r.subtasks.map(s=>[!!s.patch,!!s.diff,s.reverted,s.revertedFiles,s.patchExcludes])]);
  const signature=JSON.stringify([conversationId,messages,approvals,runUsage]);
  if(signature===lastMessages)return;lastMessages=signature;
  const area=$('#messages'),bottom=area.scrollHeight-area.scrollTop-area.clientHeight<130;
  area.innerHTML=(messages.length?messages.map(m=>`<article class="message ${m.role}"><div class="message-header">${m.role==='assistant'?`<span class="agent-avatar ${m.provider}">${symbols[m.provider]}</span><strong>${names[m.provider]}</strong>${m.stage?`<span class="message-stage">${esc(m.stage)}</span>`:''}`:'<strong>Tú</strong>'}<time>${new Date(m.createdAt).toLocaleTimeString('es',{hour:'2-digit',minute:'2-digit'})}</time>${usageBadges(m)}</div><div class="message-content">${m.content?markdown(m.content):m.status==='streaming'?'<span class="typing">Preparando la respuesta</span>':''}</div>${m.attachments?.length?`<div class="message-attachments">${m.attachments.map(a=>`<span class="chip">${a.mime?.startsWith('image/')?'🖼':'📄'} ${esc(a.name)}</span>`).join('')}</div>`:''}${m.error?`<div class="message-error">${esc(m.error)}</div>`:''}${m.content?`<div class="message-actions"><button data-copy="${m.id}">Copiar</button>${m.role==='assistant'?`<button data-remember="${m.id}">◇ Guardar recuerdo</button>`:''}${changeActions(m)}</div>`:''}</article>`).join(''):welcome())+approvals.map(approvalHtml).join('');
  if(!messages.length)area.scrollTop=0;
  else if(bottom||approvals.length||messages.length<2)area.scrollTop=area.scrollHeight;
}
// Un mensaje de trabajo con cambios en archivos ofrece verlos y, si están en tu carpeta, deshacerlos.
function changeOf(m){const run=state.runs.find(r=>r.id===m.runId);const subtask=run?.subtasks.find(s=>s.id===m.subtaskId);return subtask&&(subtask.patch||subtask.diff)?{run,subtask}:null;}
function changeActions(m){
  const found=changeOf(m);if(!found)return '';
  const {run,subtask}=found;
  const undo=subtask.diff&&!subtask.reverted&&run.phase==='done';
  return `<button data-diff="${esc(run.id)}/${esc(subtask.id)}">Ver cambios</button>${undo?`<button data-undo="${esc(run.id)}/${esc(subtask.id)}">Deshacer este turno</button>`:''}`;
}
const diffLines=text=>String(text||'').split('\n').map(l=>{const cls=l.startsWith('+')&&!l.startsWith('+++')?'add':l.startsWith('-')&&!l.startsWith('---')?'del':l.startsWith('@@')?'hunk':/^(diff |index |--- |\+\+\+ |new file|deleted file|rename |similarity |Binary)/.test(l)?'meta':'';return `<span class="${cls}">${esc(l)}</span>`;}).join('\n');
async function diffModal(runId,subtaskId){
  let d;try{d=await api(`diff?runId=${encodeURIComponent(runId)}&subtaskId=${encodeURIComponent(subtaskId)}`);}catch(error){toast(error.message);return;}
  const run=state.runs.find(r=>r.id===runId),subtask=run?.subtasks.find(s=>s.id===subtaskId);
  const fileHtml=f=>{
    const excluded=d.excluded.includes(f.path),reverted=d.reverted||d.revertedFiles.includes(f.path);
    const action=d.pending?`<button type="button" class="secondary-button" data-diff-toggle="${esc(f.path)}">${excluded?'Volver a incluir':'Excluir de la integración'}</button>`:(d.source==='diff'&&d.applied&&!reverted?`<button type="button" class="secondary-button" data-diff-revert="${esc(f.path)}">Revertir este archivo</button>`:'');
    return `<details class="diff-file ${excluded?'excluded':''}" ${f.status==='deleted'?'':'open'}><summary><span class="diff-status ${f.status}">${statusLabel[f.status]||f.status}</span> ${esc(f.path)} <span class="muted">+${f.additions} −${f.deletions}</span>${excluded?' <span class="pill">excluido</span>':''}${reverted?' <span class="pill">revertido</span>':''}</summary>${f.binary?'<p class="muted">Archivo binario.</p>':`<pre class="diff">${diffLines(f.text)}</pre>`}${action?`<div class="approval-actions">${action}</div>`:''}</details>`;
  };
  const createdHtml=c=>`<details class="diff-file" open><summary><span class="diff-status added">nuevo</span> ${esc(c.path)}${!c.exists?' <span class="pill">ya no existe</span>':''}</summary>${c.binary?'<p class="muted">Archivo binario.</p>':`<pre class="diff">${diffLines(c.text)}</pre>`}${c.exists&&d.source==='diff'&&!d.reverted&&!d.revertedFiles.includes(c.path)?`<div class="approval-actions"><button type="button" class="secondary-button" data-diff-revert="${esc(c.path)}">Eliminar este archivo</button></div>`:''}</details>`;
  const note=d.pending?'Estos cambios esperan a integrarse: puedes excluir archivos antes de aplicar.':d.source==='diff'?(d.reverted?'Este turno se deshizo entero.':'Estos cambios ya están en tu carpeta.'):d.applied?'Estos cambios ya se integraron en tu carpeta.':'Estos cambios se descartaron.';
  openModal(`Cambios · ${subtask?.title||''}`,`<p class="modal-note">${d.summary.files} archivo(s), +${d.summary.additions} −${d.summary.deletions}. ${note}</p>${d.files.map(fileHtml).join('')}${d.created.map(createdHtml).join('')}${d.source==='diff'&&d.applied&&!d.reverted?`<div class="approval-actions"><button type="button" class="danger-button" id="diff-undo-all">Deshacer todo el turno</button></div>`:''}`,'diff');
  $('#modal-content').onclick=async e=>{
    const b=e.target.closest('button');if(!b)return;
    try{
      if(b.dataset.diffToggle!==undefined)await api('revert',{runId,subtaskId,files:[b.dataset.diffToggle],toggle:true});
      else if(b.dataset.diffRevert!==undefined)await api('revert',{runId,subtaskId,files:[b.dataset.diffRevert]});
      else if(b.id==='diff-undo-all')await api('revert',{runId,subtaskId,files:[]});
      else return;
      lastMessages='';lastRun='';await load();diffModal(runId,subtaskId);toast('Hecho.');
    }catch(error){toast(error.message);}
  };
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
// Opciones de asignación: los agentes conectados y las personas del equipo del proyecto.
function assigneeOptions(selectedProvider,selectedPersonId,keepProvider){
  const providers=['codex','claude'].filter(p=>p===keepProvider||state.connections[p]?.connected);
  const people=peopleOf(project());
  return providers.map(p=>`<option value="${p}" ${p===selectedProvider?'selected':''}>${names[p]}</option>`).join('')
    +(people.length?`<optgroup label="Personas del equipo">${people.map(person=>`<option value="persona:${esc(person.id)}" ${selectedProvider===HUMAN&&person.id===selectedPersonId?'selected':''}>${esc(person.name)}${person.role?` · ${esc(person.role)}`:''}</option>`).join('')}</optgroup>`:'')
    +(selectedProvider===HUMAN&&!people.some(person=>person.id===selectedPersonId)?`<option value="persona:${esc(selectedPersonId||'')}" selected>${esc(selectedPersonId?'persona fuera del equipo':'persona')}</option>`:'');
}
function planRowHtml(subtask,run){
  const provider=subtaskProvider(subtask),model=subtaskModel(subtask),levels=effortLevels(provider,model);
  const human=provider===HUMAN,personId=planChoices[subtask.id]?.personId??subtask.personId;
  const readOnly=!human&&(subtask.readOnly||planChoices[subtask.id]?.readOnly===true);
  const moved=provider!==subtask.provider||(human&&personId!==subtask.personId);
  const shown=human?{human:true,personId,personName:state.people.find(p=>p.id===personId)?.name||subtask.personName}:{provider};
  return `<div class="plan-row"><div class="plan-row-head">${avatar(shown)}<strong>${esc(subtask.title)}</strong>${readOnly?'<span class="pill">solo lectura</span>':''}${moved?'<span class="pill">reasignada</span>':''}${human?'<span class="pill">persona: Mixto no la ejecuta</span>':''}</div>
  <div class="metadata">${esc(subtask.role)}${subtask.scope?.length?` · ${esc(subtask.scope.join(', '))}`:''}</div>
  ${subtask.justification?`<div class="metadata">${esc(subtask.justification)}</div>`:''}
  <div class="plan-row-controls"><select data-plan-provider="${esc(subtask.id)}" aria-label="Asignar ${esc(subtask.title)}">${assigneeOptions(provider,personId,subtask.provider)}</select>${human?'':`<select data-plan-model="${esc(subtask.id)}" aria-label="Modelo de ${esc(subtask.title)}">${modelOptions(provider,model)}</select>
  ${levels.length?`<select data-plan-effort="${esc(subtask.id)}" aria-label="Razonamiento de ${esc(subtask.title)}">${effortOptions(provider,model,subtaskEffort(subtask))}</select>`:''}${!subtask.readOnly&&!run?.readOnly?`<label class="readonly-control"><input type="checkbox" data-plan-readonly="${esc(subtask.id)}" ${readOnly?'checked':''}> Solo lectura</label>`:''}`}</div></div>`;
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
  const agents=run.subtasks.filter(s=>!s.human),humans=run.subtasks.filter(s=>s.human);
  const done=agents.filter(s=>['completed','error','cancelled','stopped'].includes(s.status)).length;
  return `<div class="plan-card"><div class="plan-head"><strong>${esc(run.stage||'Trabajando')}</strong><span>${run.usage?.total?`<span class="pill" title="Consumo acumulado de la tarea">${usageText(run.usage)}</span> `:''}${agents.length?`<span class="pill">${done}/${agents.length}</span>`:''}${humans.length?` <span class="pill">${humans.filter(h=>h.status==='hecha').length}/${humans.length} personas</span>`:''}</span></div>
  ${run.subtasks.length?run.subtasks.map(s=>`<details data-subtask="${esc(s.id)}" ${opened.has(s.id)?'open':''}><summary>${avatar(s)} ${esc(s.title)} · ${esc(assigneeLabel(s))} <span class="muted">· ${esc(stageNames[s.status]||s.stage||'')}</span>${s.usage?.total?`<span class="muted"> · ${fmtTokens(s.usage.total)}</span>`:''}</summary>${s.human?humanControlsHtml(run,s):`<div class="run-events">${s.events.map(e=>esc(e.text)).join('\n')||(s.status==='queued'?'En espera de su turno.':'Trabajando…')}</div>`}${s.error?`<div class="message-error">${esc(s.error)}</div>`:''}</details>`).join('')
    :`<div class="run-events">${run.events.map(e=>esc(e.text)).join('\n')||'Conectando con la sesión local…'}</div>`}
  ${(run.isolation?.warnings||[]).map(w=>`<div class="metadata">⚠ ${esc(w)}</div>`).join('')}</div>`;
}

// Una parte asignada a una persona: estado, fecha límite y resultado los anota el usuario; el encargo se copia.
function humanControlsHtml(run,s){
  return `<div class="human-controls" data-human="${esc(s.id)}" data-run="${esc(run.id)}"><select data-human-status aria-label="Estado de ${esc(s.title)}">${humanStatuses.map(([v,l])=>`<option value="${v}" ${s.status===v?'selected':''}>${l}</option>`).join('')}</select><input type="date" data-human-due value="${esc(s.due||'')}" aria-label="Fecha límite"><input data-human-result placeholder="Resultado o enlace (PR, nota)" value="${esc(s.result||'')}" aria-label="Resultado"><button type="button" class="secondary-button" data-human-save>Guardar</button><button type="button" class="secondary-button" data-human-brief="${esc(s.id)}">Copiar encargo</button></div><div class="metadata">${esc(s.role)}${s.scope?.length?` · ${esc(s.scope.join(', '))}`:''}</div><p class="human-instructions">${inline(s.instructions||'')}</p>`;
}
function conversationOf(run){return state.conversations.find(c=>c.id===run.conversationId);}
// Todas las partes asignadas a una persona en las tareas de este proyecto.
function assignmentsOf(personId){
  const convs=new Map(state.conversations.filter(c=>c.projectId===projectId).map(c=>[c.id,c]));
  const items=[];
  for(const run of state.runs)if(convs.has(run.conversationId))for(const subtask of run.subtasks||[])if(subtask.human&&subtask.personId===personId)items.push({run,subtask,conversation:convs.get(run.conversationId)});
  return items;
}
function briefFor(person,items){
  const lines=[`# Encargo para ${person.name}${project()?` · ${project().name}`:''}`,'',`Preparado con Mixto el ${new Date().toLocaleDateString('es')}.`,''];
  for(const {run,subtask,conversation} of items){
    lines.push(`## ${subtask.title}`,`Tarea: ${run.prompt.slice(0,300)}${conversation?` (conversación «${conversation.title}»)`:''}`,`Estado: ${stageNames[subtask.status]||subtask.status}${subtask.due?` · fecha límite ${subtask.due}`:''}`,`Rol: ${subtask.role}`,'',subtask.instructions||'','');
    if(subtask.scope?.length)lines.push(`Archivos o rutas: ${subtask.scope.join(', ')}`,'');
    if(run.plan?.context)lines.push('Contexto del proyecto según el arquitecto:',run.plan.context,'');
  }
  return lines.join('\n');
}
async function copyText(text,okMessage){try{await navigator.clipboard.writeText(text);toast(okMessage);}catch{toast('No se pudo copiar. Descárgalo o selecciona el texto.');}}
function downloadText(name,text){const url=URL.createObjectURL(new Blob([text],{type:'text/markdown;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function humanSubtaskById(runId,subtaskId){const run=state.runs.find(r=>r.id===runId);const subtask=run?.subtasks.find(s=>s.id===subtaskId);return run&&subtask?{run,subtask}:null;}
// Guardar estado, fecha y resultado de una parte humana desde cualquier tarjeta que muestre sus controles.
async function saveHuman(container){
  const found=humanSubtaskById(container.dataset.run,container.dataset.human);if(!found)return false;
  try{await api('subtask',{runId:found.run.id,subtaskId:found.subtask.id,status:container.querySelector('[data-human-status]').value,due:container.querySelector('[data-human-due]').value,result:container.querySelector('[data-human-result]').value});toast(`Anotado para ${personName(found.subtask)}.`);lastRun='';await load();return true;}
  catch(error){toast(error.message);return false;}
}
function humansBlockHtml(run){
  const humans=run.subtasks.filter(s=>s.human);
  if(!humans.length)return '';
  const done=humans.filter(h=>h.status==='hecha').length;
  const canReview=run.mode!=='directo'&&state.connections[run.orchestrator.provider]?.connected;
  return `<div class="plan-card"><div class="plan-head"><strong>Partes asignadas a personas</strong><span class="pill">${done}/${humans.length} hechas</span></div>
  ${humans.map(s=>`<details data-subtask="${esc(s.id)}" ${s.status!=='hecha'?'open':''}><summary>${avatar(s)} ${esc(s.title)} · ${esc(personName(s))} <span class="muted">· ${esc(stageNames[s.status]||s.status)}</span></summary>${humanControlsHtml(run,s)}</details>`).join('')}
  ${canReview?`<div class="approval-actions"><button type="button" class="secondary-button" id="review-again">Revisar de nuevo con ${esc(names[run.orchestrator.provider])}</button></div><p class="muted">Cuando las personas terminen, el revisor comprueba el conjunto en la carpeta del proyecto. Cuesta un turno.</p>`:''}</div>`;
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
  const fixable=run.subtasks.some(s=>s.fixable),humansBlock=humansBlockHtml(run);
  if(!pending&&!rejected)return humansBlock+(fixable?`<div class="after-run">${run.usage?.total?`<span class="pill" title="Consumo total de la tarea">${usageText(run.usage)} · ${run.usage.turns} turnos</span>`:''}${fixFormHtml(run,false)}</div>`:'');
  return humansBlock+`<div class="plan-card"><div class="plan-head"><strong>${pending?'Cambios sin integrar':'El revisor no autorizó la integración'}</strong>${run.usage?.total?`<span class="pill" title="Consumo total de la tarea">${usageText(run.usage)} · ${run.usage.turns} turnos</span>`:''}</div>
  ${conflicts.map(c=>`<div class="metadata">${esc(c.file)}: ${esc(c.reason)}</div>`).join('')}
  ${pending?'<p class="muted">El trabajo de los agentes está guardado aparte; tu carpeta no se tocó.</p>':'<p class="muted">Los cambios ya están en tu carpeta; lee la revisión antes de darlos por buenos.</p>'}
  ${fixFormHtml(run,true)}
  ${pending?`<div class="approval-actions"><button class="primary-button" id="integrate-apply">Aplicar cambios</button><button class="secondary-button" id="integrate-discard">Descartar</button></div>`:''}</div>`;
}

function renderRun(){
  const run=activeRun()||lastRunOf(),status=$('#run-status');
  const signature=JSON.stringify([run?.id,run?.status,run?.stage,run?.plan,run?.isolation,run?.review?.status,run?.review?.integration,run?.error,run?.usage,
    (run?.subtasks||[]).map(s=>[s.id,s.status,s.stage,s.model,s.effort,s.events.length,s.error,s.fixable,s.usage?.total,s.human,s.personId,s.result,s.due]),run?.events.length,planChoices,initRepo,state?.people?.map(p=>p.name)]);
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
  const human=row.provider===HUMAN,levels=effortLevels(row.provider,row.model);
  const shown=human?{human:true,personId:row.personId,personName:''}:{provider:row.provider};
  return `<div class="manual-row" data-row="${i}"><div class="manual-row-head">${avatar(shown)}<input data-field="title" placeholder="Sub-tarea ${i+1}: título" maxlength="120" value="${esc(row.title||'')}" aria-label="Título de la sub-tarea ${i+1}"><button type="button" class="icon-button" data-remove="${i}" aria-label="Quitar sub-tarea ${i+1}">×</button></div>
  <div class="manual-row-grid"><select data-field="provider" aria-label="Asignar a">${assigneeOptions(row.provider,row.personId,row.provider)}</select>${human?'<span class="human-note">Persona del equipo: Mixto no ejecuta esta parte; tú anotas su estado.</span>':`<select data-field="model" aria-label="Modelo">${modelOptions(row.provider,row.model)}</select>${levels.length?`<select data-field="effort" aria-label="Razonamiento">${effortOptions(row.provider,row.model,row.effort)}</select>`:''}`}<input data-field="scope" placeholder="Alcance: rutas separadas por comas (opcional)" value="${esc(row.scope||'')}" aria-label="Alcance">${human?'':`<label class="readonly-control"><input type="checkbox" data-field="readOnly" ${row.readOnly?'checked':''}> Solo lectura</label>`}</div>
  <textarea data-field="instructions" rows="2" maxlength="12000" placeholder="Qué debe hacer, con detalle suficiente para trabajar sin verte" aria-label="Instrucciones de la sub-tarea ${i+1}">${esc(row.instructions||'')}</textarea></div>`;
}
function renderManual(){
  const panel=$('#manual-panel');panel.hidden=mode!=='manual';
  if(panel.hidden)return;
  const key=JSON.stringify([manualVersion,orchestrator,state?.connections,manualOptions,peopleOf(project()).map(p=>[p.id,p.name,p.role])]);if(key===lastManual)return;lastManual=key;
  panel.innerHTML=`<div class="manual-head"><strong>Reparto a mano</strong><span class="muted">Arriba, el objetivo de la tarea; aquí, quién hace cada parte: Codex, Claude Code o una persona del equipo. Hasta 8 sub-tareas; los agentes que escriben sobre archivos distintos trabajan a la vez.</span></div>${manualRows.map(manualRowHtml).join('')}<div class="manual-actions"><button type="button" class="secondary-button" id="manual-add">＋ Sub-tarea</button><label class="readonly-control"><input type="checkbox" id="manual-review" ${manualOptions.review!==false?'checked':''}> ${names[orchestrator]} revisa al terminar</label><label class="readonly-control"><input type="checkbox" id="manual-git" ${manualOptions.initRepo?'checked':''}> Convertir la carpeta en repositorio git si hace falta para trabajar en paralelo</label></div>`;
}
$('#manual-panel').oninput=e=>{
  const rowEl=e.target.closest('[data-row]');if(!rowEl)return;
  const row=manualRows[Number(rowEl.dataset.row)],field=e.target.dataset.field;if(!row||!field)return;
  if(field==='provider'||field==='model')return;
  row[field]=e.target.type==='checkbox'?e.target.checked:e.target.value;
  remember();
};
$('#manual-panel').onchange=e=>{
  if(e.target.id==='manual-review'){manualOptions.review=e.target.checked;remember();return;}
  if(e.target.id==='manual-git'){manualOptions.initRepo=e.target.checked;remember();return;}
  const rowEl=e.target.closest('[data-row]');if(!rowEl)return;
  const row=manualRows[Number(rowEl.dataset.row)],field=e.target.dataset.field;if(!row||!field)return;
  if(field==='provider'){
    const value=e.target.value;
    if(value.startsWith('persona:')){row.provider=HUMAN;row.personId=value.slice(8);row.model='';row.effort='';row.readOnly=false;}
    else{row.provider=value;row.personId=null;row.model=defaultModel(row.provider);row.effort=defaultEffort(row.provider,row.model)||'';}
  }
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
  $('#team-count').textContent=peopleOf(project()).length;
  refreshTeamModal();
  $('#project-name').textContent=project()?.name||'';$('#conversation-title').textContent=conversation()?.title||'Nueva conversación';
  const q=conversationQuery.trim().toLowerCase();
  const matches=c=>!q||c.title.toLowerCase().includes(q)||state.messages.some(m=>m.conversationId===c.id&&String(m.content||'').toLowerCase().includes(q));
  $('#conversations').innerHTML=state.conversations.filter(c=>c.projectId===projectId&&matches(c)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(c=>`<button class="conversation-link ${c.id===conversationId?'active':''}" data-conversation="${c.id}"><span>◷</span><span>${esc(c.title)}</span></button>`).join('')||(q?'<p class="muted" style="padding:8px 12px;font-size:13px">Nada coincide.</p>':'');
  renderAgents();renderMemory();renderMessages();renderRun();renderManual();
  const run=activeRun();
  const steerable=!!run&&run.mode==='directo'&&run.status==='running';
  $('#send').hidden=!!run&&!steerable;$('#cancel-run').hidden=!run;$('#send').disabled=busy;
  const other=orchestrator==='codex'?'claude':'codex';
  $('#opinion-button').textContent=`Segunda opinión de ${names[other]}`;
  const pending=state.changes?.[projectId];
  $('#commit-button').hidden=!(pending?.git&&pending.files>0);
  if(pending?.files)$('#commit-button').textContent=`Confirmar cambios (${pending.files})`;
  $('#notify-toggle').classList.toggle('on',notifyEnabled);$('#terminal-toggle').classList.toggle('on',terminalOpen);
  renderTerminal();checkNotifications();
  updateOrchestrator();remember();
}
// Terminal del proyecto: la salida se actualiza en sitio para no perder el foco del cuadro de comando.
function renderTerminal(){
  const panel=$('#terminal-panel');panel.hidden=!terminalOpen||!projectId;if(panel.hidden)return;
  const exec=state.execs?.[projectId]||null,running=exec?.status==='running';
  const tail=exec?esc(exec.output||'')+(running?'\n…':`\n[terminado${exec.code!==null&&exec.code!==undefined?` con código ${exec.code}`:''}${exec.status==='stopped'?', detenido':''}]`):'Sin comandos ejecutados todavía.';
  if(panel.dataset.project===projectId&&panel.dataset.exec===(exec?.id||'')&&$('#terminal-output')){
    $('#terminal-output').textContent='';$('#terminal-output').innerHTML=tail;$('#terminal-output').scrollTop=$('#terminal-output').scrollHeight;
    $('#terminal-run').disabled=running;$('#terminal-stop').disabled=!running;$('#terminal-send').disabled=!exec?.output;return;
  }
  panel.dataset.project=projectId;panel.dataset.exec=exec?.id||'';
  const quick=(project()?.allowedCommands||[]).slice(0,8).map(c=>`<button type="button" class="chip" data-quick="${esc(c)}">${esc(c)}</button>`).join('');
  const current=$('#terminal-command')?.value||'';
  panel.innerHTML=`<div class="terminal-head"><strong>Terminal del proyecto</strong><span class="muted">${esc(project()?.path||'')}</span></div><form id="terminal-form" class="terminal-form"><input id="terminal-command" placeholder="Comando a ejecutar en la carpeta del proyecto" autocomplete="off" value="${esc(current)}"><button id="terminal-run" class="primary-button" ${running?'disabled':''}>Ejecutar</button><button type="button" class="secondary-button" id="terminal-stop" ${running?'':'disabled'}>Detener</button><button type="button" class="secondary-button" id="terminal-send" ${exec?.output?'':'disabled'}>Pasar al mensaje</button></form>${quick?`<div class="chips">${quick}</div>`:''}<pre id="terminal-output" class="terminal-output">${tail}</pre>`;
  $('#terminal-output').scrollTop=$('#terminal-output').scrollHeight;
  $('#terminal-form').onsubmit=async e=>{e.preventDefault();const command=$('#terminal-command').value.trim();if(!command)return;try{await api('exec',{projectId,command});$('#terminal-command').value='';await load();}catch(error){toast(error.message);}};
  $('#terminal-stop').onclick=async()=>{try{await api('exec/stop',{projectId});await load();}catch(error){toast(error.message);}};
  $('#terminal-send').onclick=()=>{const e=state.execs?.[projectId];if(!e)return;const box=$('#prompt');box.value=(box.value?box.value+'\n\n':'')+`Salida de \`${e.command}\`:\n\`\`\`\n${e.output.slice(-6000)}\n\`\`\``;box.focus();box.dispatchEvent(new Event('input'));};
  panel.querySelectorAll('[data-quick]').forEach(b=>{b.onclick=()=>{$('#terminal-command').value=b.dataset.quick;$('#terminal-form').requestSubmit();};});
}
// Avisos del sistema cuando algo cambia de estado y no estás mirando; el título lleva la cuenta de lo que espera.
function checkNotifications(){
  for(const run of state.runs){
    const previous=lastRunStates.get(run.id);
    if(previous!==undefined&&previous!==run.status&&document.hidden&&notifyEnabled&&['completed','error','cancelled','awaiting-plan','waiting'].includes(run.status)){
      const title={'awaiting-plan':'Plan listo para aprobar',waiting:'Un agente necesita tu respuesta',completed:'Tarea terminada',error:'Tarea con errores',cancelled:'Tarea detenida'}[run.status];
      try{new Notification(`Mixto · ${title}`,{body:run.prompt.slice(0,120)});}catch{}
    }
    lastRunStates.set(run.id,run.status);
  }
  // Una tarea en espera lo está por sus peticiones pendientes: se cuentan las peticiones, no la tarea otra vez.
  const waiting=state.runs.filter(r=>r.status==='awaiting-plan').length+state.approvals.length;
  document.title=(waiting?`(${waiting}) `:'')+'Mixto · Tu equipo, un espacio';
}
async function commitModal(){
  if(!projectId)return;
  openModal('Confirmar cambios','<p class="modal-note">Leyendo los cambios…</p>','commit');
  let changes;try{changes=await api(`changes?projectId=${encodeURIComponent(projectId)}`);}catch(error){toast(error.message);closeModal();return;}
  if(!changes.git){$('#modal-content').innerHTML='<p class="modal-note">La carpeta no es un repositorio git.</p>';return;}
  if(!changes.files.length){$('#modal-content').innerHTML='<p class="modal-note">No hay cambios sin confirmar.</p>';return;}
  const draw=message=>{
    $('#modal-content').innerHTML=`<form id="commit-form"><label class="form-field"><span>Mensaje del commit</span><textarea name="message" rows="4" required placeholder="Qué cambia y por qué">${esc(message||'')}</textarea><small>${message?`Propuesto por ${names[orchestrator]} a partir del diff; edítalo si quieres. Mixto solo confirma cuando pulsas.`:'Escribe el mensaje o pide una propuesta. Mixto solo confirma cuando pulsas.'}</small></label><div class="commit-files">${changes.files.map(f=>`<label class="check-field"><input type="checkbox" name="files" value="${esc(f.path)}" checked> <span class="diff-status ${f.status}">${statusLabel[f.status]||f.status}</span> ${esc(f.path)}</label>`).join('')}</div>${changes.parsed?.length?`<details><summary class="muted">Ver diff</summary>${changes.parsed.map(f=>`<details class="diff-file"><summary>${esc(f.path)} <span class="muted">+${f.additions} −${f.deletions}</span></summary><pre class="diff">${diffLines(f.text)}</pre></details>`).join('')}</details>`:''}<div class="form-footer"><button type="button" class="secondary-button" id="commit-propose">${message?'Otra propuesta':`Proponer mensaje con ${names[orchestrator]}`}</button><button class="primary-button" value="commit">Confirmar</button><button class="primary-button" value="push">Confirmar y enviar</button></div></form>`;
    $('#commit-propose').onclick=async()=>{const b=$('#commit-propose');b.disabled=true;b.textContent='Pensando…';try{const r=await api('commit/propose',{projectId,provider:orchestrator,model:selections[orchestrator],effort:efforts[orchestrator]||null});draw(r.message);}catch(error){toast(error.message);b.disabled=false;b.textContent='Proponer mensaje';}};
    $('#commit-form').onsubmit=async e=>{
      e.preventDefault();const form=e.target,files=[...form.querySelectorAll('input[name=files]:checked')].map(i=>i.value),message=form.elements.message.value.trim();
      const push=e.submitter?.value==='push';
      try{const r=await api('commit',{projectId,message,files});toast(`Commit ${r.hash} creado.`);if(push){await api('push',{projectId});toast('Commit creado y enviado al remoto.');}closeModal();await load();}
      catch(error){toast(error.message);await load();}
    };
  };
  draw('');
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
  const running=activeRun();
  $('#prompt').placeholder=running?.mode==='directo'&&running.status==='running'?`Redirigir a ${names[running.orchestrator.provider]}: escribe y envía; se detiene y sigue con lo nuevo`:mode==='manual'?'Objetivo de la tarea: qué hay que conseguir en conjunto':mode==='directo'?`Habla con ${names[orchestrator]}`:'¿Qué vamos a hacer?';
}
async function load(){
  try{state=await api('state');$('#connection-error').hidden=true;render();}catch(e){$('#connection-error').hidden=false;}
}
$('#reload').onclick=()=>location.reload();
$('#project-select').onchange=e=>{projectId=e.target.value;conversationId=null;lastMessages='';render();void api('changes/refresh',{projectId}).catch(()=>{});};
$('#conversation-search').oninput=e=>{conversationQuery=e.target.value;render();};
$('#terminal-toggle').onclick=()=>{terminalOpen=!terminalOpen;lastTerminal='';remember();render();if(terminalOpen)$('#terminal-command')?.focus();};
$('#notify-toggle').onclick=async()=>{
  if(!('Notification' in window)){toast('Este navegador no admite notificaciones.');return;}
  if(!notifyEnabled){const permission=await Notification.requestPermission();if(permission!=='granted'){toast('El navegador no ha dado permiso para avisar.');return;}}
  notifyEnabled=!notifyEnabled;remember();render();toast(notifyEnabled?'Te avisaré cuando una tarea termine o necesite algo y no estés mirando.':'Avisos desactivados.');
};
$('#commit-button').onclick=commitModal;
$('#opinion-button').onclick=async()=>{
  if(busy||activeRun())return;
  const other=orchestrator==='codex'?'claude':'codex';
  if(!projectId){toast('Crea o añade un proyecto antes de empezar.');return;}
  if(!selections[other]){toast(`Conecta ${names[other]} desde Agentes antes de pedirle una opinión.`);return;}
  busy=true;
  try{
    if(!conversationId){const c=await api('conversations',{projectId});conversationId=c.id;}
    await api('run',{conversationId,prompt:$('#prompt').value.trim(),mode:'opinion',orchestrator:{provider:other,model:selections[other],effort:efforts[other]||null}});
    $('#prompt').value='';lastMessages='';await load();
  }catch(error){toast(error.message);}finally{busy=false;}
};
// Adjuntos: pegar, arrastrar o elegir; suben al servidor local y viajan con el siguiente mensaje.
async function addFiles(files){
  for(const file of files){
    if(file.size>6*1024*1024){toast(`${file.name} pesa más de 6 MB.`);continue;}
    const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');reader.onerror=reject;reader.readAsDataURL(file);});
    try{const up=await api('upload',{name:file.name||'imagen.png',mime:file.type||'application/octet-stream',data});attachments.push(up);renderAttachments();}
    catch(error){toast(error.message);}
  }
}
function renderAttachments(){const box=$('#attachments');box.hidden=!attachments.length;box.innerHTML=attachments.map(a=>`<span class="chip">${a.mime.startsWith('image/')?'🖼':'📄'} ${esc(a.name)} <button type="button" data-detach="${esc(a.id)}" aria-label="Quitar adjunto">×</button></span>`).join('');}
$('#attachments').onclick=e=>{const b=e.target.closest('[data-detach]');if(b){attachments=attachments.filter(a=>a.id!==b.dataset.detach);renderAttachments();}};
$('#attach-button').onclick=()=>$('#attach-input').click();
$('#attach-input').onchange=e=>{addFiles([...e.target.files]);e.target.value='';};
$('#prompt').addEventListener('paste',e=>{const files=[...(e.clipboardData?.files||[])];if(files.length){e.preventDefault();addFiles(files);}});
$('#composer').addEventListener('dragover',e=>{e.preventDefault();});
$('#composer').addEventListener('drop',e=>{e.preventDefault();addFiles([...(e.dataTransfer?.files||[])]);});
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
    const value=e.target.value;
    if(value.startsWith('persona:'))planChoices[id]={...current,provider:HUMAN,personId:value.slice(8),model:null,effort:null,readOnly:false};
    else{
      // Al reasignar, el modelo y el nivel pasan a los predeterminados del otro agente.
      const provider=value,model=defaultModel(provider);
      planChoices[id]={...current,provider,personId:null,model,effort:defaultEffort(provider,model)};
    }
  } else if(planModel){
    // Al cambiar de modelo, el nivel anterior puede no existir en el nuevo: se reajusta al predeterminado.
    planChoices[id]={...current,model:e.target.value,effort:defaultEffort(subtaskProvider(subtask),e.target.value)};
  } else if(planEffort)planChoices[id]={...current,effort:e.target.value};
  else planChoices[id]={...current,readOnly:e.target.checked};
  lastRun='';renderRun();
};

$('#run-status').onclick=async e=>{
  const run=activeRun()||lastRunOf();if(!run)return;
  if(e.target.closest('[data-human-save]')){await saveHuman(e.target.closest('[data-human]'));return;}
  const brief=e.target.closest('[data-human-brief]');
  if(brief){const found=humanSubtaskById(brief.closest('[data-human]').dataset.run,brief.dataset.humanBrief);if(found){const person=state.people.find(p=>p.id===found.subtask.personId)||{name:found.subtask.personName};await copyText(briefFor(person,[{run:found.run,subtask:found.subtask,conversation:conversationOf(found.run)}]),`Encargo de ${person.name} copiado.`);}return;}
  if(e.target.id==='review-again'){try{await api('review',{runId:run.id});lastRun='';await load();toast('Revisando de nuevo el conjunto.');}catch(error){toast(error.message);}return;}
  if(!e.target.id)return;
  const act=async(route,body,done)=>{try{const result=await api(route,body);planChoices={};initRepo=false;lastRun='';await load();if(done)done(result);}catch(error){toast(error.message);}};
  if(e.target.id==='plan-approve')await act('plan',{runId:run.id,approve:true,initRepo,
    subtasks:run.subtasks.map(s=>({id:s.id,provider:subtaskProvider(s),personId:planChoices[s.id]?.personId??s.personId??null,model:subtaskModel(s),effort:subtaskEffort(s)||null,readOnly:planChoices[s.id]?.readOnly===true}))});
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
  e.preventDefault();if(busy)return;
  const input=$('#prompt'),prompt=input.value.trim();if(!prompt)return;
  const running=activeRun();
  if(running){
    // Un turno en directo se puede redirigir: se detiene y sigue en la misma sesión con lo nuevo.
    if(running.mode==='directo'&&running.status==='running'){busy=true;try{await api('steer',{runId:running.id,prompt,attachments:attachments.map(a=>a.id)});attachments=[];renderAttachments();input.value='';input.style.height='';lastMessages='';await load();}catch(error){toast(error.message);}finally{busy=false;}}
    return;
  }
  if(!projectId){toast('Crea o añade un proyecto antes de empezar.');return;}
  const body={prompt,readOnly:$('#read-only').checked,mode,attachments:attachments.map(a=>a.id),orchestrator:{provider:orchestrator,model:selections[orchestrator],effort:efforts[orchestrator]||null}};
  if(mode==='manual'){
    const rows=manualRows.map(r=>({title:(r.title||'').trim(),provider:r.provider,personId:r.personId||null,model:r.model,effort:r.effort||null,instructions:(r.instructions||'').trim(),scope:r.scope||'',readOnly:!!r.readOnly}));
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
    attachments=[];renderAttachments();
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
  const diff=e.target.closest('[data-diff]');if(diff){const [runId,subtaskId]=diff.dataset.diff.split('/');diffModal(runId,subtaskId);return;}
  const undo=e.target.closest('[data-undo]');if(undo){const [runId,subtaskId]=undo.dataset.undo.split('/');try{await api('revert',{runId,subtaskId,files:[]});lastMessages='';lastRun='';await load();toast('Turno deshecho en tu carpeta.');}catch(error){toast(error.message);}return;}
  const always=e.target.closest('[data-approval-always]');
  if(always){try{await api('approvals/'+always.dataset.approvalAlways,{allow:true,remember:true});await load();toast('Comando permitido en este proyecto a partir de ahora.');}catch(error){toast(error.message);}return;}
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
// Equipo del proyecto: personas, sus encargos (del libro del repositorio o locales) y la cooperación por git.
function fromLocalItem(i){return {id:i.subtask.id,title:i.subtask.title,status:i.subtask.status,due:i.subtask.due,notes:i.subtask.result?[i.subtask.result]:[],instructions:i.subtask.instructions,scope:i.subtask.scope||[],context:i.run.plan?.context||'',task:i.run.prompt,run:i.run,subtask:i.subtask,conversation:i.conversation,source:'local',personId:i.subtask.personId,personName:personName(i.subtask)};}
// Encargos de una persona: los del libro (o sueltos) más las partes de tareas locales que aún no estén en él.
function boardItems(personId){
  const p=project();if(!p)return [];
  const items=[],locals=assignmentsOf(personId),source=p.cooperation?.enabled?'repo':'standalone';
  for(const a of (p.assignments||[]).filter(a=>a.personId===personId)){
    const [runId,subtaskId]=String(a.origin||'').split('/');
    const local=locals.find(i=>i.run.id===runId&&i.subtask.id===subtaskId);
    items.push({id:a.id,title:a.title,status:a.status,due:a.due,notes:a.notes||[],instructions:a.instructions,scope:a.scope||[],context:a.context,task:a.task,run:local?.run,subtask:local?.subtask,conversation:local?.conversation,source,personId,personName:a.personName});
  }
  for(const i of locals)if(!items.some(x=>x.run===i.run&&x.subtask===i.subtask))items.push(fromLocalItem(i));
  return items.sort((x,y)=>((x.status==='hecha')-(y.status==='hecha'))||String(x.due||'9').localeCompare(String(y.due||'9')));
}
function itemControlsHtml(item){
  return `<div class="human-controls" data-item="${esc(item.id)}" data-source="${item.source}" ${item.run?`data-run="${esc(item.run.id)}" data-subtask="${esc(item.subtask.id)}"`:''}><select data-item-status aria-label="Estado de ${esc(item.title)}">${humanStatuses.map(([v,l])=>`<option value="${v}" ${item.status===v?'selected':''}>${l}</option>`).join('')}</select><input type="date" data-item-due value="${esc(item.due||'')}" aria-label="Fecha límite"><input data-item-note placeholder="Añadir nota o resultado" aria-label="Nota"><button type="button" class="secondary-button" data-item-save>Guardar</button><button type="button" class="secondary-button" data-item-brief>Copiar encargo</button></div>
  ${item.notes.length?`<ul class="item-notes">${item.notes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul>`:''}
  <div class="metadata">${item.task?`Tarea: ${esc(String(item.task).slice(0,120))}`:'Encargo suelto'}${item.conversation?` · <button type="button" class="text-link" data-open-conversation="${esc(item.conversation.id)}">ir a la conversación</button>`:''} · ${item.source==='repo'?'en el repositorio':'solo en este Mixto'}</div>
  <p class="human-instructions">${inline(item.instructions||'')}</p>`;
}
const briefFromItems=(person,items)=>briefFor(person,items.map(i=>({run:i.run||{prompt:i.task||'',plan:{context:i.context||''}},subtask:{title:i.title,status:i.status,due:i.due,role:i.run?i.subtask.role:'',instructions:i.instructions,scope:i.scope},conversation:i.conversation})));
function coopSectionHtml(p){
  const coop=p.cooperation||{},identity=coop.identity;
  let who='';
  if(!coop.enabled)who='Activa la cooperación para que Mixto lea tu identidad de git y comparta el libro de encargos.';
  else if(identity?.personId)who=`En este repositorio eres <strong>${esc(state.people.find(x=>x.id===identity.personId)?.name||identity.name)}</strong> (${esc(identity.email)}).`;
  else if(identity?.email)who=`Tu git dice <strong>${esc(identity.email)}</strong>, que no está en el equipo. <button type="button" class="text-link" id="coop-add-me">Añadirme al equipo con esa identidad</button>`;
  else if(identity)who='Tu git no tiene <code>user.email</code>; configúralo para que Mixto sepa quién eres en este repositorio.';
  else who='Preparando el libro de encargos…';
  const publish=coop.lastPublish,noRemote=coop.enabled&&coop.lastSync&&!coop.remote;
  const status=[coop.lastSync?`Última sincronización ${new Date(coop.lastSync).toLocaleString('es')}`:'',
    publish?`Última publicación ${new Date(publish.at).toLocaleString('es')}: ${publish.pushed?'enviada al remoto':publish.committed?'confirmada solo en local':'sin cambios'}`:'',
    noRemote?'Sin remoto: los encargos solo viven en este repositorio.':'',coop.pendingPublish?'Hay cambios sin publicar.':'',
    coop.lastEvent?esc(coop.lastEvent.text):'',coop.error?`Aviso: ${esc(coop.error)}`:''].filter(Boolean).join(' · ');
  return `<section class="coop-card"><h3>Cooperación por git</h3><p class="modal-note">Los encargos y el equipo se guardan en la rama <code>mixto-encargos</code> del repositorio del proyecto, aparte de tus ramas de código. Cualquier Mixto que abra un clon del mismo repositorio los verá y sabrá quién es cada uno por el correo de su git. Un commit con <code>mixto:&lt;id&gt;</code> en el mensaje, en cualquier rama, da el encargo por hecho; también se puede cambiar el estado o añadir notas desde cualquier Mixto o editando el archivo.</p>
  <label class="check-field"><input type="checkbox" id="coop-enabled" ${coop.enabled?'checked':''}> Compartir el equipo y los encargos en el repositorio</label>
  <label class="check-field"><input type="checkbox" id="coop-auto" ${coop.autoPublish!==false?'checked':''} ${coop.enabled?'':'disabled'}> Publicar automáticamente (commit y push de la rama de encargos)</label>
  <div class="metadata">${who}</div>${status?`<div class="metadata">${status}</div>`:''}
  <div class="approval-actions"><button type="button" class="secondary-button" id="coop-sync" ${coop.enabled?'':'disabled'}>Sincronizar ahora</button><button type="button" class="secondary-button" id="coop-publish" ${coop.enabled?'':'disabled'}>Publicar ahora</button></div></section>`;
}
let lastTeam='';
function teamKey(){const p=project();return JSON.stringify([projectId,p?.members,p?.assignments,p?.cooperation,state?.people,state?.runs.map(r=>r.subtasks.filter(s=>s.human).map(s=>[s.id,s.status,s.due,s.result]))]);}
// Si el tablero está abierto y no estás escribiendo en él, se repinta cuando llegan cambios del repositorio.
function refreshTeamModal(){
  if(!$('#modal').open||$('#modal').dataset.type!=='team')return;
  const focus=document.activeElement;
  if(focus&&$('#modal').contains(focus)&&['INPUT','TEXTAREA','SELECT'].includes(focus.tagName))return;
  if(teamKey()===lastTeam)return;
  teamModal();
}
function teamModal(){
  const p=project();if(!p){toast('Crea o añade un proyecto antes.');return;}
  const members=peopleOf(p),others=state.people.filter(person=>!(p.members||[]).includes(person.id));
  const meId=p.cooperation?.identity?.personId;
  const ordered=[...members].sort((x,y)=>(y.id===meId)-(x.id===meId));
  const personCard=person=>{
    const items=boardItems(person.id),pending=items.filter(i=>i.status!=='hecha');
    return `<section class="person-card" data-person="${esc(person.id)}"><header><span class="agent-avatar human">👤</span><div><h3>${esc(person.name)}${person.id===meId?' <span class="pill">tú</span>':''}</h3><div class="metadata">${esc(person.role||'sin rol')}${person.email?` · ${esc(person.email)}`:''}${person.notes?` · ${esc(person.notes)}`:''}</div></div><span class="pill">${items.length-pending.length}/${items.length} hechas</span></header>
    ${items.length?items.map(item=>`<details data-subtask="${esc(item.id)}" ${item.status!=='hecha'?'open':''}><summary>${esc(item.title)} <span class="muted">· ${esc(stageNames[item.status]||item.status)}${item.due?` · límite ${esc(item.due)}`:''}</span></summary>${itemControlsHtml(item)}</details>`).join(''):'<p class="muted">Sin encargos todavía. Asígnale una parte desde el reparto a mano, desde el plan del arquitecto o con «Nuevo encargo».</p>'}
    <footer>${pending.length?`<button type="button" class="secondary-button" data-brief-copy="${esc(person.id)}">Copiar encargo (${pending.length})</button><button type="button" class="secondary-button" data-brief-download="${esc(person.id)}">Descargar .md</button>${person.email?`<button type="button" class="secondary-button" data-brief-mail="${esc(person.id)}">Enviar por correo</button>`:''}`:''}<button type="button" class="secondary-button" data-person-edit="${esc(person.id)}">Editar</button><button type="button" class="danger-button" data-person-remove="${esc(person.id)}">Quitar del proyecto</button></footer></section>`;
  };
  const strays=(p.assignments||[]).filter(a=>!members.some(m=>m.id===a.personId));
  const strayHtml=strays.length?`<section class="person-card"><header><span class="agent-avatar human">👤</span><div><h3>Encargos de personas fuera del equipo</h3></div></header>${strays.map(a=>`<details data-subtask="${esc(a.id)}"><summary>${esc(a.title)} <span class="muted">· ${esc(a.personName||'?')} · ${esc(stageNames[a.status]||a.status)}</span></summary>${itemControlsHtml({id:a.id,title:a.title,status:a.status,due:a.due,notes:a.notes||[],instructions:a.instructions,scope:a.scope||[],context:a.context,task:a.task,source:p.cooperation?.enabled?'repo':'standalone'})}</details>`).join('')}</section>`:'';
  openModal(`Equipo de ${p.name}`,`<p class="modal-note">Personas reales que trabajan en este proyecto. Asígnales partes desde el reparto a mano, desde el plan del arquitecto o con un encargo suelto; aquí anotas su estado y sus notas y les preparas el encargo. Mixto no ejecuta sus partes, y el arquitecto las tiene en cuenta al planificar y al revisar.</p>
    ${coopSectionHtml(p)}
    <div id="team-board">${(ordered.map(personCard).join('')+strayHtml)||'<div class="memory-empty">Todavía no hay nadie en el equipo.</div>'}</div>
    ${members.length?`<form id="assignment-form" class="person-form"><h3>Nuevo encargo</h3><div class="person-grid"><label class="form-field"><span>Título</span><input name="title" required maxlength="120" placeholder="Probar el flujo de pago"></label><label class="form-field"><span>Para</span><select name="personId" required>${members.map(person=>`<option value="${esc(person.id)}">${esc(person.name)}</option>`).join('')}</select></label><label class="form-field"><span>Fecha límite (opcional)</span><input type="date" name="due"></label></div><label class="form-field"><span>Encargo</span><textarea name="instructions" rows="3" required maxlength="12000" placeholder="Qué debe hacer, con detalle suficiente para trabajar sin verte"></textarea></label><label class="form-field"><span>Alcance (rutas separadas por comas, opcional)</span><input name="scope"></label><div class="form-footer"><button class="primary-button">Crear encargo</button></div></form>`:''}
    <form id="person-form" class="person-form"><h3 id="person-form-title">Añadir persona</h3><input type="hidden" name="id"><div class="person-grid"><label class="form-field"><span>Nombre</span><input name="name" required maxlength="80" placeholder="Ana"></label><label class="form-field"><span>Rol</span><input name="role" maxlength="80" placeholder="frontend, QA, producto…"></label><label class="form-field"><span>Correo (el de su git, para reconocerla en el repositorio)</span><input name="email" type="email" maxlength="200" placeholder="ana@ejemplo.com"></label></div><label class="form-field"><span>Notas (lo que el arquitecto debe saber para asignarle trabajo)</span><textarea name="notes" rows="2" maxlength="2000" placeholder="Sabe React; no tiene acceso al servidor; disponible por las tardes"></textarea></label><div class="form-footer">${others.length?`<select id="person-existing" aria-label="Añadir una persona de otro proyecto"><option value="">Añadir de otro proyecto…</option>${others.map(person=>`<option value="${esc(person.id)}">${esc(person.name)}${person.role?` · ${esc(person.role)}`:''}</option>`).join('')}</select>`:''}<button type="button" class="secondary-button" id="person-cancel" hidden>Cancelar</button><button class="primary-button" id="person-save">Añadir al equipo</button></div></form>`,'team');
  lastTeam=teamKey();
  const form=$('#person-form');
  const resetForm=()=>{form.reset();form.elements.id.value='';$('#person-form-title').textContent='Añadir persona';$('#person-save').textContent='Añadir al equipo';$('#person-cancel').hidden=true;};
  $('#person-cancel').onclick=resetForm;
  form.onsubmit=async e=>{
    e.preventDefault();const values=Object.fromEntries(new FormData(form));
    try{
      if(values.id)await api('people/'+values.id,{name:values.name,role:values.role,email:values.email,notes:values.notes},'PATCH');
      else await api('people',{...values,projectId});
      await load();teamModal();toast(values.id?'Persona actualizada.':'Persona añadida al equipo.');
    }catch(error){toast(error.message);}
  };
  if($('#person-existing'))$('#person-existing').onchange=async e=>{if(!e.target.value)return;try{await api('members',{projectId,personId:e.target.value});await load();teamModal();}catch(error){toast(error.message);}};
  if($('#assignment-form'))$('#assignment-form').onsubmit=async e=>{e.preventDefault();const values=Object.fromEntries(new FormData(e.target));try{await api('assignments',{...values,projectId});await load();teamModal();toast('Encargo creado.');}catch(error){toast(error.message);}};
  $('#coop-enabled').onchange=async e=>{try{await api('cooperation',{projectId,enabled:e.target.checked});await load();teamModal();toast(e.target.checked?'Cooperación activada: el libro de encargos se está preparando en el repositorio.':'Cooperación desactivada; el libro queda como está en el repositorio.');}catch(error){toast(error.message);await load();teamModal();}};
  $('#coop-auto').onchange=async e=>{try{await api('cooperation',{projectId,autoPublish:e.target.checked});await load();}catch(error){toast(error.message);}};
  $('#coop-sync').onclick=async()=>{const b=$('#coop-sync');b.disabled=true;b.textContent='Sincronizando…';try{const r=await api('cooperation/sync',{projectId});await load();teamModal();toast(r.fetchError?'Sincronizado en local; no se pudo traer del remoto: '+r.fetchError:r.autoDone.length?`Sincronizado: ${r.autoDone.length} encargo(s) dados por hechos por sus commits.`:'Sincronizado con el repositorio.');}catch(error){toast(error.message);await load();teamModal();}};
  $('#coop-publish').onclick=async()=>{const b=$('#coop-publish');b.disabled=true;b.textContent='Publicando…';try{const r=await api('cooperation/publish',{projectId});await load();teamModal();toast(r.pushed?'Encargos publicados en el remoto.':r.committed?'Confirmado en local. '+(r.error||''):r.error||'No había cambios que publicar.');}catch(error){toast(error.message);await load();teamModal();}};
  if($('#coop-add-me'))$('#coop-add-me').onclick=async()=>{const identity=project().cooperation?.identity;try{await api('people',{name:identity.name||identity.email.split('@')[0],email:identity.email,role:'',notes:'',projectId});await api('cooperation/sync',{projectId,fetch:false});await load();teamModal();toast('Ya estás en el equipo de este repositorio.');}catch(error){toast(error.message);}};
  const personFor=id=>state.people.find(x=>x.id===id);
  $('#team-board').onclick=async e=>{
    const b=e.target.closest('button');if(!b)return;
    if(b.dataset.personEdit){const person=personFor(b.dataset.personEdit);if(!person)return;form.elements.id.value=person.id;form.elements.name.value=person.name;form.elements.role.value=person.role||'';form.elements.email.value=person.email||'';form.elements.notes.value=person.notes||'';$('#person-form-title').textContent=`Editar a ${person.name}`;$('#person-save').textContent='Guardar';$('#person-cancel').hidden=false;form.elements.name.focus();return;}
    if(b.dataset.personRemove){try{await api('members',{projectId,personId:b.dataset.personRemove,remove:true});await load();teamModal();toast('Persona quitada del proyecto; sus encargos se conservan.');}catch(error){toast(error.message);}return;}
    if(b.dataset.openConversation){conversationId=b.dataset.openConversation;closeModal();lastMessages='';lastRun='';render();return;}
    if(b.dataset.briefCopy){const person=personFor(b.dataset.briefCopy);await copyText(briefFromItems(person,boardItems(person.id).filter(i=>i.status!=='hecha')),`Encargo de ${person.name} copiado.`);return;}
    if(b.dataset.briefDownload){const person=personFor(b.dataset.briefDownload);downloadText(`encargo-${person.name.replace(/[^\w.-]+/g,'-').toLowerCase()}.md`,briefFromItems(person,boardItems(person.id).filter(i=>i.status!=='hecha')));return;}
    if(b.dataset.briefMail){const person=personFor(b.dataset.briefMail);const brief=briefFromItems(person,boardItems(person.id).filter(i=>i.status!=='hecha'));location.href=`mailto:${encodeURIComponent(person.email)}?subject=${encodeURIComponent(`Encargo · ${project()?.name||'Mixto'}`)}&body=${encodeURIComponent(brief.slice(0,1800))}`;return;}
    if(b.hasAttribute('data-item-save')){
      const c=b.closest('[data-item]');const status=c.querySelector('[data-item-status]').value,due=c.querySelector('[data-item-due]').value,note=c.querySelector('[data-item-note]').value.trim();
      try{
        if(c.dataset.source==='local')await api('subtask',{runId:c.dataset.run,subtaskId:c.dataset.subtask,status,due,...(note?{result:note}:{})});
        else await api('assignments/'+c.dataset.item,{projectId,status,due,...(note?{note}:{})},'PATCH');
        await load();teamModal();toast('Anotado.');
      }catch(error){toast(error.message);}
      return;
    }
    if(b.hasAttribute('data-item-brief')){const c=b.closest('[data-item]'),card=b.closest('[data-person]');const person=personFor(card?.dataset.person)||{name:'persona'};const item=(card?boardItems(person.id):[]).find(i=>i.id===c.dataset.item)||(project().assignments||[]).map(a=>({...a,notes:a.notes||[],scope:a.scope||[],source:'repo'})).find(i=>i.id===c.dataset.item);if(item)await copyText(briefFromItems(person,[item]),'Encargo copiado.');}
  };
}
$('#open-team').onclick=teamModal;
function connectionsModal(){
  openModal('Agentes',`<p class="modal-note">Mixto usa las sesiones de las herramientas instaladas. Aquí solo configuras lo necesario para orquestar.</p>${['codex','claude'].map(p=>{const c=state.connections[p],levels=effortLevels(p,selections[p]);return `<section class="connection-card"><h3><span class="agent-avatar ${p}">${symbols[p]}</span> ${names[p]}</h3><p>${c.loading?'Consultando conexión…':c.connected?'Conectado · '+esc(c.plan||c.authType):'Sin conexión'}</p>${limitsHtml(p,c)}${c.error?`<div class="message-error">${esc(c.error)}</div>`:''}${!c.connected?`<p>Inicia sesión con <code>${p==='codex'?'codex login':'claude auth login'}</code> y pulsa Actualizar.</p>`:''}${c.models.length?`<label class="form-field compact-field"><span>Modelo predeterminado</span><select data-agent-model="${p}">${modelOptions(p,selections[p])}</select><small>Cuando ${names[p]} orquesta, este modelo planifica y revisa: uno rápido abarata cada tarea. Los modelos potentes se eligen por sub-tarea en el plan.</small></label>${levels.length?`<label class="form-field compact-field"><span>Razonamiento</span><select data-agent-effort="${p}">${effortOptions(p,selections[p],efforts[p])}</select></label>`:''}`:''}</section>`;}).join('')}<form id="agent-settings"><label class="form-field"><span>Persona del arquitecto</span><select name="orchestratorPersona"><option value="">Sin persona</option>${state.personas.map(p=>`<option value="${esc(p.id)}" ${p.id===state.settings.orchestratorPersona?'selected':''}>${esc(p.name)}</option>`).join('')}</select><small>Añade unos 7.000 tokens de texto genérico a cada plan. Déjala en «Sin persona» salvo que la necesites.</small></label><label class="check-field"><input type="checkbox" name="autoApproveSingle" ${state.settings.autoApproveSingle?'checked':''}> Empezar sin pedir aprobación cuando el plan tiene una sola sub-tarea</label><label class="check-field"><input type="checkbox" name="autoApproveReadOnly" ${state.settings.autoApproveReadOnly?'checked':''}> Empezar sin pedir aprobación cuando todas las sub-tareas son de solo lectura</label><label class="form-field"><span>Comandos permitidos en ${esc(project()?.name||'este proyecto')} (uno por línea; «npm test» permite «npm test» y «npm test -- x»)</span><textarea name="allowedCommands" rows="3" placeholder="npm test&#10;npm run check&#10;git status">${esc((project()?.allowedCommands||[]).join('\n'))}</textarea><small>Los agentes ejecutan estos comandos sin preguntar, también el revisor. El botón «Permitir siempre» de cada petición los añade aquí.</small></label><label class="form-field"><span>Tope de tokens por tarea (0 = sin tope)</span><input type="number" name="tokenBudget" min="0" step="1000" value="${Number(state.settings.tokenBudget)||0}"><small>Se comprueba al cerrar cada turno, así que puede excederse por un turno. Al superarlo la tarea se detiene y te lo dice; una corrección la reanuda.</small></label>${['codex','claude'].map(p=>`<label class="form-field"><span>Preferencias para ${names[p]}</span><textarea name="${p}Instructions" rows="3" maxlength="8000" placeholder="Cómo quieres que trabaje este agente…">${esc(state.settings[p+'Instructions'])}</textarea></label>`).join('')}<div class="form-footer"><button type="button" class="secondary-button" id="refresh-connections">Actualizar</button><button class="primary-button">Guardar</button></div></form>`,'connections');
  $('#modal-content').onchange=e=>{
    const model=e.target.dataset.agentModel,effort=e.target.dataset.agentEffort;
    if(model){selections[model]=e.target.value;efforts[model]=defaultEffort(model,e.target.value)||'';lastAgents='';renderAgents();connectionsModal();}
    if(effort){efforts[effort]=e.target.value;remember();}
  };
  $('#agent-settings').onsubmit=async e=>{e.preventDefault();const form=new FormData(e.target);
    // Una casilla sin marcar no viaja en FormData: los booleanos se envían explícitamente.
    const body={orchestratorPersona:form.get('orchestratorPersona')||'',codexInstructions:form.get('codexInstructions')||'',claudeInstructions:form.get('claudeInstructions')||'',autoApproveSingle:form.has('autoApproveSingle'),autoApproveReadOnly:form.has('autoApproveReadOnly'),tokenBudget:Number(form.get('tokenBudget'))||0};
    try{await api('settings',body);if(projectId)await api('projects/'+projectId+'/settings',{allowedCommands:String(form.get('allowedCommands')||'').split('\n')});await load();toast('Preferencias guardadas.');}catch(error){toast(error.message);}};
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
load().then(()=>{if(projectId)void api('changes/refresh',{projectId}).catch(()=>{});});connectEvents();
setInterval(()=>{if(!document.hidden&&(!events||events.readyState!==1))load();},5000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});
