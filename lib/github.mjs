// Conexión con GitHub: un token de acceso personal guardado en local sirve para listar tus repositorios,
// clonarlos en la carpeta de proyectos y para que git (el de Mixto, el de los agentes y el del terminal)
// pueda traer y enviar cambios sin pedir credenciales. El token nunca sale de tu ordenador.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run=promisify(execFile);
const HOST='https://github.com';
export const AUTH_KEYS=['GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0'];

export function githubSources(env=process.env){
  return {
    api:String(env.MIXTO_GITHUB_API||'https://api.github.com').replace(/\/+$/,''),
    cloneBase:String(env.MIXTO_GITHUB_CLONE_BASE||HOST).replace(/\/+$/,''),
    web:HOST
  };
}

// Cabecera de autorización para git, como la usa GitHub Actions: se inyecta por variables de entorno
// (git 2.31+), así el token no aparece en la línea de comandos ni en ningún archivo de configuración.
export function authEnv(token){
  if(!token)return {};
  const basic=Buffer.from('x-access-token:'+token,'utf8').toString('base64');
  return {GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:`http.${HOST}/.extraheader`,GIT_CONFIG_VALUE_0:'AUTHORIZATION: basic '+basic};
}
export function applyAuth(token,env=process.env){
  clearAuth(env);
  Object.assign(env,authEnv(token));
  return env;
}
export function clearAuth(env=process.env){
  for(const key of AUTH_KEYS)delete env[key];
  return env;
}

// «owner/repo» a partir de lo que pegue el usuario: la URL de la web, la de clonado, la de ssh o el nombre.
export function parseRepoInput(text){
  const value=String(text||'').trim();
  const match=/^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(value);
  if(!match||match[1]==='.'||match[1]==='..'||match[2]==='.'||match[2]==='..')return null;
  return `${match[1]}/${match[2]}`;
}

export async function githubRequest(sources,token,route,{method='GET',body,fetchImpl=fetch}={}){
  const response=await fetchImpl(sources.api+route,{method,signal:AbortSignal.timeout(20000),
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'Mixto',...(body?{'Content-Type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{})});
  if(response.status===401)throw new Error('GitHub no acepta el token: revisa que esté bien copiado y que no haya caducado.');
  if(response.status===403)throw new Error('GitHub ha rechazado la petición (permisos insuficientes o límite de peticiones).');
  if(!response.ok)throw new Error(`GitHub respondió ${response.status}.`);
  return response.json();
}

export async function fetchViewer(sources,token,options){
  const user=await githubRequest(sources,token,'/user',options);
  if(!user?.login)throw new Error('GitHub no ha devuelto un usuario.');
  return {login:user.login,name:user.name||'',avatarUrl:user.avatar_url||''};
}

export async function fetchRepos(sources,token,options){
  const repos=[];
  for(let page=1;page<=5;page++){
    const batch=await githubRequest(sources,token,`/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`,options);
    if(!Array.isArray(batch))break;
    for(const repo of batch)if(repo?.full_name)repos.push({fullName:repo.full_name,name:repo.name,owner:repo.owner?.login||repo.full_name.split('/')[0],private:repo.private===true,
      description:repo.description||'',defaultBranch:repo.default_branch||'main',pushedAt:repo.pushed_at||null,htmlUrl:repo.html_url||`${sources.web}/${repo.full_name}`,language:repo.language||''});
    if(batch.length<100)break;
  }
  return repos;
}

export const cloneUrl=(sources,fullName)=>`${sources.cloneBase}/${fullName}.git`;

export async function cloneRepo({sources,fullName,into,env=process.env,timeout=15*60*1000}){
  try{
    await run('git',['clone','--quiet',cloneUrl(sources,fullName),into],{windowsHide:true,env:{...env,GIT_TERMINAL_PROMPT:'0'},timeout,maxBuffer:16*1024*1024});
    return {ok:true,error:null};
  }catch(error){return {ok:false,error:String(error.stderr||error.message||error).trim().split('\n').pop()||'git clone falló.'};}
}

export async function pullProject(projectPath,env=process.env){
  try{
    const out=await run('git',['-C',projectPath,'pull','--ff-only','--quiet'],{windowsHide:true,env:{...env,GIT_TERMINAL_PROMPT:'0'},timeout:5*60*1000,maxBuffer:16*1024*1024});
    return {ok:true,error:null,output:String(out.stderr||'').trim()};
  }catch(error){return {ok:false,error:String(error.stderr||error.message||error).trim().split('\n').pop()||'git pull falló.'};}
}

export async function hasRemote(projectPath){
  try{const out=await run('git',['-C',projectPath,'remote'],{windowsHide:true,timeout:10000});return String(out.stdout).trim().length>0;}
  catch{return false;}
}

// Lo que pasa en el repositorio de verdad, leído de la API de GitHub: pull requests abiertas, con el estado
// de sus comprobaciones, y la última actividad de una rama. Sirve para que Mixto (y los agentes) trabajen
// sobre el estado real del proyecto, no sobre la foto del día que se clonó.
export async function fetchPulls(sources,token,fullName,options){
  const list=await githubRequest(sources,token,`/repos/${fullName}/pulls?state=open&per_page=20&sort=updated&direction=desc`,options);
  if(!Array.isArray(list))return [];
  return list.map(pull=>({
    number:pull.number,title:pull.title||'',author:pull.user?.login||'',draft:pull.draft===true,
    head:pull.head?.ref||'',base:pull.base?.ref||'',updatedAt:pull.updated_at||null,
    htmlUrl:pull.html_url||`${sources.web}/${fullName}/pull/${pull.number}`
  }));
}

// Estado de las comprobaciones (CI) de un commit: éxito, fallo, en marcha o sin comprobaciones.
export async function fetchChecks(sources,token,fullName,ref,options){
  try{
    const data=await githubRequest(sources,token,`/repos/${fullName}/commits/${encodeURIComponent(ref)}/check-runs?per_page=50`,options);
    const runs=Array.isArray(data?.check_runs)?data.check_runs:[];
    if(!runs.length)return {state:'none',total:0,failed:[],pending:0};
    const failed=runs.filter(run=>['failure','timed_out','action_required'].includes(run.conclusion)).map(run=>run.name||'');
    const pending=runs.filter(run=>run.status!=='completed').length;
    return {state:failed.length?'failure':pending?'pending':'success',total:runs.length,failed,pending};
  }catch{return {state:'unknown',total:0,failed:[],pending:0};}
}

export async function fetchRepoMeta(sources,token,fullName,options){
  const repo=await githubRequest(sources,token,`/repos/${fullName}`,options);
  return {defaultBranch:repo?.default_branch||'main',private:repo?.private===true,pushable:repo?.permissions?.push!==false,htmlUrl:repo?.html_url||`${sources.web}/${fullName}`};
}

export async function createPull(sources,token,fullName,{title,body='',head,base},options){
  const pull=await githubRequest(sources,token,`/repos/${fullName}/pulls`,{...options,method:'POST',body:{title,body,head,base}});
  return {number:pull.number,htmlUrl:pull.html_url,title:pull.title};
}
