import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const ACTIVE = ['planning','awaiting-plan','running','waiting','reviewing','integrating','queued'];
const SESSION_LIMIT = 20;

// One conversation can now hold several instances of the same provider at once, so a session belongs to
// a provider *and* its model, role and permission level — never to the provider alone.
export const sessionKey = ({provider,model,role='',readOnly}) =>
  `${provider}:${model}:${String(role).toLocaleLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,24)}:${readOnly?'read':'work'}`;

export function rememberSession(conversation,key,sessionId) {
  if(!key||!sessionId)return;
  conversation.sessions||={};
  delete conversation.sessions[key];
  conversation.sessions[key]=sessionId;
  const keys=Object.keys(conversation.sessions);
  for(const stale of keys.slice(0,Math.max(0,keys.length-SESSION_LIMIT)))delete conversation.sessions[stale];
}
export class Store {
  constructor(directory, workspace) {
    fs.mkdirSync(directory,{recursive:true});
    this.file=path.join(directory,'mixto.json');
    if(fs.existsSync(this.file)) {
      // Never silently replace a damaged history with an empty database.
      this.data=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(this.data.version!==1 || !Array.isArray(this.data.projects)) throw new Error('Formato de memoria no compatible. Conserva data/ y revisa la copia de seguridad.');
    } else {
      this.data={version:1,projects:[],conversations:[],messages:[],memories:[],runs:[],settings:{}};
    }
    // Ajustes nuevos con su valor por defecto, sin perder los que el usuario ya tenía guardados.
    this.data.settings={codexInstructions:'',claudeInstructions:'',orchestratorPersona:'',autoApproveSingle:false,autoApproveReadOnly:false,...(this.data.settings||{})};
    for(const run of this.data.runs) {
      if(ACTIVE.includes(run.status)){run.status='interrupted';run.error='La app se cerró antes de terminar. Puedes volver a enviar la tarea.';}
      for(const subtask of run.subtasks||[]) if(ACTIVE.includes(subtask.status)){subtask.status='interrupted';subtask.stage='Sin completar';}
    }
    for(const m of this.data.messages) if(m.status==='streaming')m.status='interrupted';
    this.save();
  }
  save() {
    const tmp=this.file+'.tmp';
    const fd=fs.openSync(tmp,'w',0o600);
    try {fs.writeFileSync(fd,JSON.stringify(this.data,null,2));fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    if(fs.existsSync(this.file))fs.copyFileSync(this.file,this.file+'.bak');
    fs.renameSync(tmp,this.file);
  }
  project(projectId){const p=this.data.projects.find(p=>p.id===projectId);if(!p)throw new Error('Proyecto no encontrado.');return p;}
  conversation(conversationId){const c=this.data.conversations.find(c=>c.id===conversationId);if(!c)throw new Error('Conversación no encontrada.');return c;}
}

export function memoryContext(data,projectId,conversationId,query) {
  const tokens=new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[]);
  const score=text=>[...tokens].reduce((n,t)=>n+(text.toLocaleLowerCase().includes(t)?1:0),0);
  const notes=data.memories.filter(m=>!m.projectId||m.projectId===projectId);
  // Explicit memories always take precedence over automatically recalled history.
  const pinned=notes.filter(m=>!m.automatic).sort((a,b)=>score(b.content)-score(a.content));
  const recalled=notes.filter(m=>m.automatic&&m.conversationId!==conversationId)
    .sort((a,b)=>score(b.content)-score(a.content)||b.createdAt.localeCompare(a.createdAt)).slice(0,5);
  const render=m=>`[${m.needsReview?'MEMORIA PENDIENTE DE REVISIÓN, verificar antes de usar':m.automatic?'Registro de trabajo, verificar antes de asumir':'Recuerdo guardado por el usuario'}; ${m.createdAt}; ${m.provider||'compartido'}]\n${m.content}`;
  return [...pinned.map(render),...recalled.map(render)].join('\n\n').slice(0,24000);
}
