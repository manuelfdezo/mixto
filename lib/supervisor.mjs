import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run=promisify(execFile);
const norm=value=>String(value||'').replace(/\\/g,'/').toLocaleLowerCase();

// Turns a simple `*`/`**` glob into a regex. `**` crosses folders, `*` stops at the next `/`.
function globToRegex(pattern){
  let re='';
  for(let i=0;i<pattern.length;i++){
    const c=pattern[i];
    if(c==='*'&&pattern[i+1]==='*'){
      re+='.*';i++;
      if(pattern[i+1]==='/')i++;
    } else if(c==='*')re+='[^/]*';
    else if('.+^${}()|[]\\'.includes(c))re+='\\'+c;
    else re+=c;
  }
  return new RegExp('^'+re+'$');
}

// An empty scope means the sub-task declared no limit, so nothing it touches can be an invasion.
export function matchesScope(file,scope){
  const list=Array.isArray(scope)?scope.filter(Boolean):[];
  if(!list.length)return true;
  const target=norm(file);
  return list.some(entry=>{
    const pattern=norm(entry).replace(/\/+$/,'');
    if(!pattern)return false;
    if(pattern.includes('*'))return globToRegex(pattern).test(target);
    return target===pattern||target.startsWith(pattern+'/');
  });
}

// Pure detection over already-collected snapshots: no I/O here, so it stays trivially testable.
export function detect(snapshots){
  const list=Array.isArray(snapshots)?snapshots:[];
  const owners=new Map();
  for(const snap of list)for(const file of snap.files||[]){
    const key=norm(file);
    if(!owners.has(key))owners.set(key,{file,indexes:new Set()});
    owners.get(key).indexes.add(snap.index);
  }
  const events=[];
  for(const {file,indexes} of owners.values())
    if(indexes.size>1)events.push({type:'colision',file,indexes:[...indexes].sort((a,b)=>a-b)});
  for(const snap of list){
    if(!snap.scope?.length)continue;
    for(const file of snap.files||[])if(!matchesScope(file,snap.scope))events.push({type:'invasion',index:snap.index,file});
  }
  events.sort((a,b)=>{
    const fa=norm(a.file),fb=norm(b.file);
    if(fa!==fb)return fa<fb?-1:1;
    return (a.type==='colision'?a.indexes[0]:a.index)-(b.type==='colision'?b.indexes[0]:b.index);
  });
  return events;
}

function statusFiles(output){
  return String(output||'').split('\n').map(line=>line.trim()).filter(Boolean).map(line=>{
    const entry=line.slice(2).trim(),renamed=entry.split(' -> ');
    return (renamed[renamed.length-1]||'').replace(/^"|"$/g,'');
  }).filter(Boolean);
}

// Polls every isolated worktree for a running wave and surfaces only events never reported before.
export class Watcher{
  constructor({roots,subtasks,intervalMs=1500,onEvents}){
    this.roots=roots;this.subtasks=subtasks;this.intervalMs=intervalMs;this.onEvents=onEvents;
    this.seen=new Set();this.timer=null;
  }
  start(){
    void this.poll();
    this.timer=setInterval(()=>{void this.poll();},this.intervalMs);
    this.timer.unref?.();
  }
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  async poll(){
    const snapshots=[];
    for(const subtask of this.subtasks){
      const root=this.roots.get(subtask.index);
      if(!root)continue;
      try{
        const {stdout}=await run('git',['-C',root,'status','--porcelain','--untracked-files=all'],{windowsHide:true});
        snapshots.push({index:subtask.index,scope:subtask.scope||[],files:statusFiles(stdout)});
      }catch{/* a worktree mid-teardown fails here; the others still get watched */}
    }
    const fresh=detect(snapshots).filter(event=>{
      const key=event.type==='colision'?`colision:${norm(event.file)}:${event.indexes.join(',')}`:`invasion:${event.index}:${norm(event.file)}`;
      if(this.seen.has(key))return false;
      this.seen.add(key);return true;
    });
    if(fresh.length)this.onEvents(fresh);
  }
}
