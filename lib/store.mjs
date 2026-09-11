import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export class Store {
  constructor(directory, workspace) {
    fs.mkdirSync(directory,{recursive:true});
    this.file=path.join(directory,'mixto.json');
    if(fs.existsSync(this.file)) {
      // Never silently replace a damaged history with an empty database.
      this.data=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(this.data.version!==1 || !Array.isArray(this.data.projects)) throw new Error('Formato de memoria no compatible. Conserva data/ y revisa la copia de seguridad.');
    } else {
      this.data={version:1,projects:[{id:id(),name:'Mi espacio',path:workspace,description:'',createdAt:now()}],conversations:[],messages:[],memories:[],runs:[],settings:{codexInstructions:'',claudeInstructions:''}};
    }
    for(const run of this.data.runs) if(['running','waiting','queued'].includes(run.status)){run.status='interrupted';run.error='La app se cerró antes de terminar. Puedes volver a enviar la tarea.';}
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
