const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={codex:'Codex',claude:'Claude Code'};
const symbols={codex:'✳',claude:'✺'};
const effortNames={low:'Ligero',medium:'Equilibrado',high:'Alto',xhigh:'Muy alto',max:'Máximo',ultra:'Ultra'};
let state,projectId,conversationId,mode='solo',leader='codex',busy=false,lastMessages='',lastAgents='',lastMemory='',toastTimer;
let preferences;try{preferences=JSON.parse(localStorage.getItem('mixto-preferences')||'{}');}catch{preferences={};}
const selections=preferences.models||{},efforts=preferences.efforts||{};
projectId=preferences.projectId;conversationId=preferences.conversationId;

async function api(route,body,method=body===undefined?'GET':'POST'){
  const response=await fetch('/api/'+route,{method,headers:body===undefined?{}:{'Content-Type':'application/json','X-Mixto-Client':'1'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'No se pudo completar la acción.');return data;
}
function remember(){try{localStorage.setItem('mixto-preferences',JSON.stringify({projectId,conversationId,models:selections,efforts}));}catch{}}
function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,5500);}
const project=()=>state?.projects.find(p=>p.id===projectId);
const conversation=()=>state?.conversations.find(c=>c.id===conversationId);
const activeRun=()=>state?.runs.find(r=>r.conversationId===conversationId&&['running','waiting','queued'].includes(r.status));
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

function welcome(){return `<div class="welcome"><div class="welcome-symbol"><span>✺</span><span>✳</span></div><div class="eyebrow">DOS INTELIGENCIAS. UN MISMO EQUIPO.</div><h1>Haz espacio a<br><em>lo que quieres crear.</em></h1><p>Trabaja con Claude y Codex en una misma conversación. Elige quién empieza; la memoria viaja con el equipo.</p><div class="suggestions"><button class="suggestion" data-suggestion="Explora este proyecto y explícame cómo está organizado y cuál sería el siguiente paso." data-suggestion-mode="solo"><span>⌁</span> Entender mi proyecto<small>Una visión clara para empezar</small></button><button class="suggestion" data-suggestion="Analiza este proyecto y propón tres mejoras concretas. El segundo agente debe revisar la propuesta." data-suggestion-mode="review"><span>⇄</span> Pensarlo entre los dos<small>Una propuesta, una segunda mirada</small></button></div></div>`;}

function approvalHtml(a){
  const questions=a.details?.questions||[];
  const questionMode=a.kind==='question'||a.kind==='claude-question';
  return `<section class="approval" data-approval="${esc(a.id)}"><h3>${esc(a.title)}</h3>${questionMode?questions.map((q,i)=>`<label class="question-label"><span>${esc(q.question||q.header)}</span>${q.options?.length?`<small class="muted">${q.options.map(o=>esc(o.label)).join(' · ')}</small>`:''}<input data-answer="${i}" placeholder="Tu respuesta" autocomplete="off"></label>`).join(''):`<pre>${esc(JSON.stringify(a.details,null,2))}</pre>`}<div class="approval-actions"><button class="primary-button" data-approval-allow="${esc(a.id)}">${questionMode?'Enviar respuesta':'Permitir esta vez'}</button><button class="secondary-button" data-approval-deny="${esc(a.id)}">${questionMode?'Omitir':'Rechazar'}</button></div></section>`;
}

function renderMessages(){
  const messages=state.messages.filter(m=>m.conversationId===conversationId);
  const approvals=state.approvals.filter(a=>state.runs.find(r=>r.id===a.runId)?.conversationId===conversationId);
  const signature=JSON.stringify([conversationId,messages,approvals]);
  if(signature===lastMessages)return;lastMessages=signature;
  const area=$('#messages'),bottom=area.scrollHeight-area.scrollTop-area.clientHeight<130;
  area.innerHTML=(messages.length?messages.map(m=>`<article class="message ${m.role}"><div class="message-header">${m.role==='assistant'?`<span class="agent-avatar ${m.provider}">${symbols[m.provider]}</span><strong>${names[m.provider]}</strong>${m.stage?`<span class="message-stage">${esc(m.stage)}</span>`:''}`:'<strong>Tú</strong>'}<time>${new Date(m.createdAt).toLocaleTimeString('es',{hour:'2-digit',minute:'2-digit'})}</time></div><div class="message-content">${m.content?markdown(m.content):m.status==='streaming'?'<span class="typing">Preparando la respuesta</span>':''}</div>${m.error?`<div class="message-error">${esc(m.error)}</div>`:''}${m.content?`<div class="message-actions"><button data-copy="${m.id}">Copiar</button>${m.role==='assistant'?`<button data-remember="${m.id}">◇ Guardar recuerdo</button>`:''}</div>`:''}</article>`).join(''):welcome())+approvals.map(approvalHtml).join('');
  if(!messages.length)area.scrollTop=0;
  else if(bottom||approvals.length||messages.length<2)area.scrollTop=area.scrollHeight;
}
function renderAgents(){
  const key=JSON.stringify([state.connections,selections,efforts]);if(key===lastAgents)return;lastAgents=key;
  $('#agent-cards').innerHTML=['codex','claude'].map(p=>{
    const c=state.connections[p],models=c.models||[];
    if(models.length&&(!selections[p]||(p==='codex'&&selections[p]==='default'&&!models.some(m=>m.id==='default'))))selections[p]=(models.find(m=>m.default)||models.find(m=>!m.hidden))?.id;
    const chosen=models.find(m=>m.id===selections[p]);
    const levels=chosen?.efforts||[];
    if(!levels.includes(efforts[p]))efforts[p]=levels.includes(chosen?.defaultEffort)?chosen.defaultEffort:levels[0]||'';
    return `<div class="agent-card"><div class="agent-header"><span class="agent-avatar ${p}">${symbols[p]}</span><span class="agent-name">${names[p]}</span><span class="status-dot ${c.loading?'loading':c.connected?'':'off'}" title="${c.loading?'Conectando':c.connected?'Conectado':'Desconectado'}"></span></div><div class="agent-meta">${c.loading?'Consultando modelos…':c.connected?esc(c.plan||'Sesión conectada'):'Pendiente de conexión'}</div><select data-model="${p}" aria-label="Modelo de ${names[p]}">${models.map(m=>`<option value="${esc(m.id)}" ${m.id===selections[p]?'selected':''}>${esc(m.name)}${m.hidden?' · oculto':''}</option>`).join('')}${!chosen?`<option value="${esc(selections[p])}" selected>${esc(selections[p])}${models.length?' · manual':''}</option>`:''}<option value="__custom__">Otro identificador…</option></select>${levels.length?`<label class="effort-row">Razonamiento<select data-effort="${p}" aria-label="Razonamiento de ${names[p]}">${levels.map(e=>`<option value="${e}" ${e===efforts[p]?'selected':''}>${effortNames[e]||e}</option>`).join('')}</select></label>`:''}</div>`;
  }).join('');remember();
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
  const previews=[...memories.filter(m=>!m.automatic).reverse(),...memories.filter(m=>m.automatic).reverse()].slice(0,3);
  $('#memory-preview').innerHTML=previews.length?previews.map(m=>`<div class="memory-mini"><strong>${esc(m.title)}</strong><p>${esc(m.content)}</p></div>`).join(''):'<div class="memory-empty">Todavía no hay recuerdos.<br>Añade una preferencia o empieza una conversación.</div>';
}
function render(){
  if(!state.projects.some(p=>p.id===projectId))projectId=state.projects[0]?.id;
  if(!state.conversations.some(c=>c.id===conversationId&&c.projectId===projectId))conversationId=null;
  const select=$('#project-select');if(document.activeElement!==select)select.innerHTML=state.projects.map(p=>`<option value="${p.id}" ${p.id===projectId?'selected':''}>${esc(p.name)}</option>`).join('');
  $('#project-folder').textContent=project()?.path||'';$('#project-folder').title=project()?.path||'';
  $('#project-name').textContent=project()?.name||'';$('#conversation-title').textContent=conversation()?.title||'Nueva conversación';
  $('#conversations').innerHTML=state.conversations.filter(c=>c.projectId===projectId).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(c=>`<button class="conversation-link ${c.id===conversationId?'active':''}" data-conversation="${c.id}"><span>◷</span><span>${esc(c.title)}</span></button>`).join('');
  renderAgents();renderMemory();renderMessages();
  const run=activeRun(),latest=state.runs.filter(r=>r.conversationId===conversationId).at(-1);
  $('#send').hidden=!!run;$('#cancel-run').hidden=!run;$('#send').disabled=busy;
  const status=$('#run-status');
  if(run){status.hidden=false;const opened=status.querySelector('details')?.open;status.innerHTML=`<details ${opened?'open':''}><summary>${esc(names[run.provider]||'Equipo')} · ${run.status==='waiting'?'Esperando tu respuesta':esc(run.stage)} <span class="muted"> · ver actividad</span></summary><div class="run-events">${run.events.map(e=>esc(e.text)).join('\n')||'Conectando con la sesión local…'}</div></details>`;}
  else if(latest?.error){status.hidden=false;status.textContent=latest.error;}
  else status.hidden=true;
  updateMode();remember();
}
function updateMode(){
  document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('selected',b.dataset.mode===mode));
  const other=leader==='codex'?'claude':'codex';
  const text=mode==='solo'?`${names[leader]} trabaja con la memoria de tu proyecto.`:mode==='review'?`${names[leader]} trabaja → ${names[other]} revisa.`:'Los dos responden por separado. Sin modificar archivos.';
  $('#mode-hint').textContent=text;$('#flow-explanation').textContent=text;
  $('#leader-symbol').textContent=symbols[leader];
  $('#read-only').disabled=mode==='compare';
  if(mode==='compare')$('#read-only').checked=true;
}
async function load(){
  try{state=await api('state');$('#connection-error').hidden=true;render();}catch(e){$('#connection-error').hidden=false;}
}
$('#reload').onclick=()=>location.reload();
$('#project-select').onchange=e=>{projectId=e.target.value;conversationId=null;lastMessages='';render();};
$('#conversations').onclick=e=>{const b=e.target.closest('[data-conversation]');if(b){conversationId=b.dataset.conversation;lastMessages='';render();}};
$('#new-conversation').onclick=()=>{conversationId=null;lastMessages='';render();$('#prompt').focus();};
$('#leader').onchange=e=>{leader=e.target.value;updateMode();};
document.querySelector('.mode-tabs').onclick=e=>{if(e.target.dataset.mode){mode=e.target.dataset.mode;updateMode();}};
$('#memory-toggle').onclick=()=>{if(matchMedia('(min-width:951px)').matches)memoryList();else $('#context-panel').classList.toggle('revealed');};
$('#context-close').onclick=()=>$('#context-panel').classList.remove('revealed');

$('#agent-cards').onchange=e=>{
  if(e.target.dataset.effort){efforts[e.target.dataset.effort]=e.target.value;remember();return;}
  const p=e.target.dataset.model;if(!p)return;
  if(e.target.value==='__custom__'){
    openModal('Elegir otro modelo',`<form id="custom-model"><p class="modal-note">Escribe un identificador que admita tu cuenta. Mixto lo enviará al proveedor; la disponibilidad se comprobará al utilizarlo.</p><label class="form-field"><span>Identificador de ${names[p]}</span><input id="custom-model-value" required maxlength="200" placeholder="Identificador del modelo"></label><div class="form-footer"><button class="primary-button">Usar modelo</button></div></form>`);
    $('#custom-model').onsubmit=event=>{event.preventDefault();selections[p]=$('#custom-model-value').value.trim();efforts[p]='';closeModal();lastAgents='';renderAgents();};
  }else{selections[p]=e.target.value;lastAgents='';renderAgents();}
};

$('#composer').onsubmit=async e=>{
  e.preventDefault();if(busy||activeRun())return;
  const input=$('#prompt'),prompt=input.value.trim();if(!prompt)return;
  busy=true;$('#send').disabled=true;
  try{
    if(!conversationId){const c=await api('conversations',{projectId});conversationId=c.id;}
    await api('run',{conversationId,prompt,mode,leader,models:{...selections},efforts:{...efforts},readOnly:$('#read-only').checked});
    input.value='';input.style.height='';lastMessages='';await load();$('#messages').scrollTop=$('#messages').scrollHeight;
  }catch(error){toast(error.message);await load();}finally{busy=false;$('#send').disabled=false;}
};
$('#prompt').onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();$('#composer').requestSubmit();}};
$('#prompt').oninput=e=>{e.target.style.height='auto';e.target.style.height=Math.min(e.target.scrollHeight,220)+'px';};
$('#cancel-run').onclick=async()=>{try{await api('cancel',{id:activeRun().id});await load();}catch(e){toast(e.message);}};
$('#messages').onclick=async e=>{
  const suggestion=e.target.closest('[data-suggestion]');if(suggestion){$('#prompt').value=suggestion.dataset.suggestion;mode=suggestion.dataset.suggestionMode;updateMode();$('#prompt').focus();return;}
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
  openModal('Añadir un proyecto',`<form id="project-form"><label class="form-field"><span>Nombre</span><input name="name" required maxlength="80" placeholder="Mi próximo proyecto" autofocus></label><label class="form-field"><span>Carpeta del proyecto</span><input name="path" required placeholder="C:\\Users\\Usuario\\Desktop\\mi-proyecto"><small>Usa una carpeta existente de tu ordenador. Ambos agentes trabajarán en ella.</small></label><label class="form-field"><span>Descripción (opcional)</span><textarea name="description" rows="2" maxlength="2000"></textarea></label><div class="form-footer"><button class="primary-button">Crear proyecto</button></div></form>`);
  $('#project-form').onsubmit=async e=>{e.preventDefault();try{const p=await api('projects',Object.fromEntries(new FormData(e.target)));projectId=p.id;conversationId=null;closeModal();await load();toast('Proyecto añadido.');}catch(error){toast(error.message);}};
};

function memoryForm(existing={}){
  openModal(existing.id?'Editar recuerdo':'Añadir un recuerdo',`<form id="memory-form"><label class="form-field"><span>Título</span><input name="title" required maxlength="100" value="${esc(existing.title||'')}" placeholder="Una preferencia, una decisión…"></label><label class="form-field"><span>Qué deben recordar los dos agentes</span><textarea name="content" required rows="7" maxlength="12000" placeholder="Por ejemplo: este proyecto usa TypeScript y prefiero explicaciones breves.">${esc(existing.content||'')}</textarea></label>${!existing.id?`<label class="form-field"><span>Disponible en</span><select name="scope"><option value="project">${esc(project().name)}</option><option value="global">Todos mis proyectos</option></select></label>`:''}<div class="form-footer"><button class="primary-button">Guardar recuerdo</button></div></form>`);
  $('#memory-form').onsubmit=async e=>{e.preventDefault();const values=Object.fromEntries(new FormData(e.target));try{if(existing.id)await api('memories/'+existing.id,values,'PATCH');else await api('memories',{...values,projectId:values.scope==='global'?null:projectId});closeModal();await load();toast('Recuerdo guardado para los dos agentes.');}catch(error){toast(error.message);}};
}
$('#add-memory').onclick=()=>memoryForm();
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
$('#open-memory').onclick=memoryList;$('#all-memory').onclick=memoryList;
function connectionsModal(){
  openModal('Conexiones y agentes',`<p class="modal-note">Mixto utiliza las sesiones de tus aplicaciones instaladas. Los límites y el acceso a modelos dependen de cada cuenta.</p>${['codex','claude'].map(p=>{const c=state.connections[p];return `<section class="connection-card"><h3><span class="agent-avatar ${p}">${symbols[p]}</span> ${names[p]}</h3><p>${c.loading?'Consultando conexión…':c.connected?'Conectado · '+esc(c.plan||c.authType):'Sin conexión'}</p>${c.error?`<div class="message-error">${esc(c.error)}</div>`:''}${!c.connected?`<p>Abre una terminal e inicia sesión con <code>${p==='codex'?'codex login':'claude auth login'}</code>. Después pulsa Actualizar.</p>`:''}<details><summary>${c.models.length} modelos detectados · ver catálogo</summary><ul>${c.models.map(m=>`<li><strong>${esc(m.name)}</strong> · ${esc(m.resolved||m.id)}${m.hidden?' (oculto en el selector oficial)':''}</li>`).join('')}</ul></details></section>`;}).join('')}<form id="agent-settings">${['codex','claude'].map(p=>`<label class="form-field"><span>Preferencias para ${names[p]}</span><textarea name="${p}Instructions" rows="3" maxlength="8000" placeholder="Cómo quieres que trabaje este agente…">${esc(state.settings[p+'Instructions'])}</textarea></label>`).join('')}<div class="form-footer"><button type="button" class="secondary-button" id="refresh-connections">Actualizar conexiones</button><button class="primary-button">Guardar preferencias</button></div></form>`,'connections');
  $('#agent-settings').onsubmit=async e=>{e.preventDefault();try{await api('settings',Object.fromEntries(new FormData(e.target)));await load();toast('Preferencias guardadas.');}catch(error){toast(error.message);}};
  $('#refresh-connections').onclick=async()=>{
    const button=$('#refresh-connections');button.disabled=true;button.textContent='Consultando…';
    try{await api('connections',{});await load();let attempts=0;while(Object.values(state.connections).some(c=>c.loading)&&attempts++<50){await new Promise(r=>setTimeout(r,1000));await load();}if($('#modal').open&&$('#modal').dataset.type==='connections')connectionsModal();}catch(error){toast(error.message);button.disabled=false;}
  };
}
$('#open-connections').onclick=connectionsModal;
document.addEventListener('keydown',e=>{if(e.key.toLowerCase()==='n'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)&&!$('#modal').open){e.preventDefault();$('#new-conversation').click();}});

const webContext=document.modelContext;
if(webContext?.registerTool){
  try{Promise.resolve(webContext.registerTool({name:'read_mixto_project_memory',title:'Consultar memoria de Mixto',description:'Lee los recuerdos guardados del proyecto seleccionado en Mixto. No ejecuta agentes ni modifica datos.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:input=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new Error('No se admiten parámetros.');if(!state)throw new Error('Mixto aún está cargando.');return {project:project().name,memories:scopedMemories().map(m=>({title:m.title,content:m.content,automatic:m.automatic}))};}})).catch(()=>{});}catch{}
}
load();setInterval(()=>{if(!document.hidden)load();},1200);document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});
