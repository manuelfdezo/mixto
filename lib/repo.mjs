// El repositorio de verdad, en vivo. Un proyecto de Mixto ya no es una copia congelada: sabe en qué rama
// está, cuántos commits le faltan del remoto, qué hay sin confirmar y qué ha pasado en GitHub desde la
// última vez. Los agentes trabajan sobre archivos locales (no hay otra forma), pero esos archivos se
// mantienen al día con el repositorio original y el estado se les cuenta antes de empezar.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {parseRepoInput} from './github.mjs';

const run=promisify(execFile);
const MAX=16*1024*1024;
const git=async(cwd,args,{timeout=60000}={})=>(await run('git',['-C',cwd,...args],{windowsHide:true,maxBuffer:MAX,timeout,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}})).stdout;
const quiet=async(cwd,args,options)=>{try{return (await git(cwd,args,options)).trim();}catch{return '';}};
const lines=text=>String(text||'').split('\n').map(line=>line.trim()).filter(Boolean);
const reasonOf=error=>String(error?.stderr||error?.message||error).trim().split('\n').filter(Boolean).pop()||'git falló.';

// Un commit tal como se enseña en la interfaz.
const COMMIT_FORMAT='%H%x1f%h%x1f%an%x1f%aI%x1f%s';
const parseCommits=text=>lines(text).map(line=>{
  const [hash,short,author,date,subject]=line.split('\x1f');
  return {hash,short,author,date,subject:subject||''};
});

export async function remoteFullName(projectPath,remote='origin'){
  // La URL tal cual está configurada: «git remote get-url» aplica las reescrituras de insteadOf y dejaría
  // de reconocer el repositorio de GitHub cuando el usuario redirige el transporte.
  const url=await quiet(projectPath,['config','--get',`remote.${remote}.url`])||await quiet(projectPath,['remote','get-url',remote]);
  return url?parseRepoInput(url):null;
}

// Estado completo del repositorio del proyecto, leído del propio git (rápido, sin red).
export async function repoState(projectPath,{commits=5}={}){
  const toplevel=await quiet(projectPath,['rev-parse','--show-toplevel']);
  if(!toplevel)return {git:false,reason:'Esta carpeta no es un repositorio git.'};
  const branch=await quiet(toplevel,['rev-parse','--abbrev-ref','HEAD']);
  const head=parseCommits(await quiet(toplevel,['log','-1',`--pretty=format:${COMMIT_FORMAT}`]))[0]||null;
  if(!head)return {git:true,empty:true,branch:branch||'main',reason:'El repositorio todavía no tiene ningún commit.'};
  const remotes=lines(await quiet(toplevel,['remote']));
  const remote=remotes.includes('origin')?'origin':remotes[0]||null;
  const upstream=await quiet(toplevel,['rev-parse','--abbrev-ref','--symbolic-full-name','@{upstream}']);
  let ahead=0,behind=0,incoming=[];
  if(upstream){
    const counts=(await quiet(toplevel,['rev-list','--left-right','--count',`HEAD...${upstream}`])).split(/\s+/);
    ahead=Number(counts[0])||0;behind=Number(counts[1])||0;
    if(behind)incoming=parseCommits(await quiet(toplevel,['log',`HEAD..${upstream}`,'--max-count='+commits,`--pretty=format:${COMMIT_FORMAT}`]));
  }
  const status=lines(await quiet(toplevel,['status','--porcelain']));
  const fullName=remote?await remoteFullName(toplevel,remote):null;
  return {
    git:true,empty:false,toplevel,branch:branch==='HEAD'?`(sin rama) ${head.short}`:branch,
    detached:branch==='HEAD',remote,fullName,upstream:upstream||null,ahead,behind,incoming,
    dirty:status.length,staged:status.filter(line=>line[0]!==' '&&line[0]!=='?').length,
    head,recent:parseCommits(await quiet(toplevel,['log','--max-count='+commits,`--pretty=format:${COMMIT_FORMAT}`])),
    reason:''
  };
}

// Trae del remoto sin tocar los archivos: así el estado sabe qué hay de nuevo antes de decidir nada.
export async function fetchRemote(projectPath,{remote='origin',prune=true,env=process.env}={}){
  try{
    await run('git',['-C',projectPath,'fetch','--quiet',...(prune?['--prune']:[]),remote],
      {windowsHide:true,maxBuffer:MAX,timeout:120000,env:{...env,GIT_TERMINAL_PROMPT:'0'}});
    return {ok:true,error:null};
  }catch(error){return {ok:false,error:reasonOf(error)};}
}

export async function listBranches(projectPath){
  const toplevel=await quiet(projectPath,['rev-parse','--show-toplevel']);
  if(!toplevel)return {local:[],remote:[],current:null};
  const current=await quiet(toplevel,['rev-parse','--abbrev-ref','HEAD']);
  const local=lines(await quiet(toplevel,['for-each-ref','--sort=-committerdate','--format=%(refname:short)','refs/heads']));
  const remote=lines(await quiet(toplevel,['for-each-ref','--sort=-committerdate','--format=%(refname:short)','refs/remotes']))
    .filter(name=>!name.endsWith('/HEAD')).map(name=>name.replace(/^[^/]+\//,''));
  return {local,remote:[...new Set(remote)].filter(name=>!local.includes(name)),current};
}

// Cambiar de rama solo con el árbol limpio: nunca se arrastran cambios sin querer de una rama a otra.
export async function switchBranch(projectPath,name,{create=false,from=''}={}){
  const toplevel=await quiet(projectPath,['rev-parse','--show-toplevel']);
  if(!toplevel)return {ok:false,error:'Esta carpeta no es un repositorio git.'};
  if(!/^[\w./-]{1,200}$/.test(String(name||''))||String(name).startsWith('-'))return {ok:false,error:'Nombre de rama no válido.'};
  const status=lines(await quiet(toplevel,['status','--porcelain','--untracked-files=no']));
  if(status.length)return {ok:false,error:'Tienes cambios sin confirmar: confírmalos o deshazlos antes de cambiar de rama.'};
  try{
    if(create)await git(toplevel,['switch','--create',name,...(from?[from]:[])]);
    else await git(toplevel,['switch',name]);
    return {ok:true,error:null};
  }catch(error){
    // Una rama que solo existe en el remoto se crea siguiéndola.
    if(!create){try{await git(toplevel,['switch','--track','origin/'+name]);return {ok:true,error:null};}catch{}}
    return {ok:false,error:reasonOf(error)};
  }
}

// Traer los commits del remoto a la rama actual, sin mezclar a ciegas: solo avance directo.
export async function pullFastForward(projectPath,{env=process.env}={}){
  const toplevel=await quiet(projectPath,['rev-parse','--show-toplevel']);
  if(!toplevel)return {ok:false,error:'Esta carpeta no es un repositorio git.'};
  try{
    const out=await run('git',['-C',toplevel,'merge','--ff-only','@{upstream}'],{windowsHide:true,maxBuffer:MAX,timeout:120000,env:{...env,GIT_TERMINAL_PROMPT:'0'}});
    return {ok:true,error:null,output:String(out.stdout||'').trim()};
  }catch(error){return {ok:false,error:reasonOf(error)};}
}

export async function pushBranchUpstream(projectPath,{env=process.env}={}){
  const toplevel=await quiet(projectPath,['rev-parse','--show-toplevel']);
  if(!toplevel)return {ok:false,error:'Esta carpeta no es un repositorio git.'};
  const branch=await quiet(toplevel,['rev-parse','--abbrev-ref','HEAD']);
  if(!branch||branch==='HEAD')return {ok:false,error:'No estás en una rama.'};
  const upstream=await quiet(toplevel,['rev-parse','--abbrev-ref','--symbolic-full-name','@{upstream}']);
  try{
    const out=await run('git',['-C',toplevel,'push',...(upstream?[]:['--set-upstream','origin',branch])],
      {windowsHide:true,maxBuffer:MAX,timeout:180000,env:{...env,GIT_TERMINAL_PROMPT:'0'}});
    return {ok:true,error:null,output:String(out.stderr||out.stdout||'').trim(),branch};
  }catch(error){return {ok:false,error:reasonOf(error)};}
}

// Lo que el agente debe saber del repositorio antes de tocar nada.
export function repoNote(state,{pulls=[]}={}){
  if(!state?.git)return '';
  if(state.empty)return 'ESTADO DEL REPOSITORIO: todavía sin commits.';
  const parts=[`ESTADO DEL REPOSITORIO (en vivo):`,`- Rama: ${state.branch}${state.upstream?` (sigue a ${state.upstream})`:' (sin rama remota)'}`];
  if(state.fullName)parts.push(`- Repositorio: ${state.fullName}`);
  parts.push(`- Último commit: ${state.head.short} · ${state.head.subject} · ${state.head.author}`);
  if(state.behind)parts.push(`- Te faltan ${state.behind} commit(s) del remoto: ${state.incoming.map(c=>c.subject).slice(0,3).join(' / ')}`);
  if(state.ahead)parts.push(`- Tienes ${state.ahead} commit(s) sin enviar al remoto.`);
  parts.push(state.dirty?`- Hay ${state.dirty} archivo(s) con cambios sin confirmar.`:'- El árbol de trabajo está limpio.');
  if(pulls.length)parts.push(`- Pull requests abiertas: ${pulls.slice(0,5).map(p=>`#${p.number} ${p.title} (${p.head}→${p.base})`).join('; ')}`);
  return parts.join('\n');
}
