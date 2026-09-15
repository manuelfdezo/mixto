import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRepoInput,authEnv,applyAuth,clearAuth,githubSources,fetchViewer,fetchRepos,cloneUrl} from '../lib/github.mjs';

test('parseRepoInput entiende URL web, de clonado, ssh y owner/repo',()=>{
  for(const input of ['https://github.com/manuelfdezo/mixto','https://github.com/manuelfdezo/mixto.git','https://www.github.com/manuelfdezo/mixto/','git@github.com:manuelfdezo/mixto.git','github.com/manuelfdezo/mixto','manuelfdezo/mixto',' manuelfdezo/mixto '])
    assert.equal(parseRepoInput(input),'manuelfdezo/mixto',input);
  for(const bad of ['','mixto','https://gitlab.com/a/b','a/../b','../x','a/b/c',null])assert.equal(parseRepoInput(bad),null,String(bad));
});

test('la autorización de git viaja por entorno con el formato de GitHub Actions y se puede retirar',()=>{
  const env={PATH:'/bin'};
  applyAuth('ghp_secreto',env);
  assert.equal(env.GIT_CONFIG_COUNT,'1');
  assert.equal(env.GIT_CONFIG_KEY_0,'http.https://github.com/.extraheader');
  assert.equal(env.GIT_CONFIG_VALUE_0,'AUTHORIZATION: basic '+Buffer.from('x-access-token:ghp_secreto').toString('base64'));
  applyAuth('otro',env);
  assert.equal(env.GIT_CONFIG_COUNT,'1','no se acumulan entradas');
  clearAuth(env);
  assert.deepEqual(env,{PATH:'/bin'});
  assert.deepEqual(authEnv(''),{});
});

test('las fuentes se pueden redirigir por entorno y la URL de clonado sale de ellas',()=>{
  const sources=githubSources({MIXTO_GITHUB_API:'http://127.0.0.1:1/',MIXTO_GITHUB_CLONE_BASE:'file:///tmp/clones/'});
  assert.equal(sources.api,'http://127.0.0.1:1');
  assert.equal(cloneUrl(sources,'a/b'),'file:///tmp/clones/a/b.git');
  assert.equal(cloneUrl(githubSources({}),'a/b'),'https://github.com/a/b.git');
});

test('el usuario y los repositorios se leen de la API con paginación y errores claros',async()=>{
  const sources=githubSources({MIXTO_GITHUB_API:'http://api.test'});
  const calls=[];
  const fetchImpl=async(url,options)=>{
    calls.push(url);
    assert.equal(options.headers.Authorization,'Bearer tok');
    if(url.endsWith('/user'))return {ok:true,status:200,json:async()=>({login:'ana',name:'Ana',avatar_url:'http://a/x.png'})};
    const page=Number(/[?&]page=(\d+)/.exec(url)[1]);
    const make=i=>({full_name:`ana/r${i}`,name:`r${i}`,owner:{login:'ana'},private:i%2===0,description:null,default_branch:'main',pushed_at:'2026-01-01T00:00:00Z',html_url:`https://github.com/ana/r${i}`});
    return {ok:true,status:200,json:async()=>page===1?Array.from({length:100},(_,i)=>make(i)):[make(100)]};
  };
  assert.deepEqual(await fetchViewer(sources,'tok',{fetchImpl}),{login:'ana',name:'Ana',avatarUrl:'http://a/x.png'});
  const repos=await fetchRepos(sources,'tok',{fetchImpl});
  assert.equal(repos.length,101);
  assert.equal(calls.filter(u=>u.includes('/user/repos')).length,2,'dos páginas y para');
  assert.deepEqual(repos[0],{fullName:'ana/r0',name:'r0',owner:'ana',private:true,description:'',defaultBranch:'main',pushedAt:'2026-01-01T00:00:00Z',htmlUrl:'https://github.com/ana/r0',language:''});
  await assert.rejects(fetchViewer(sources,'malo',{fetchImpl:async()=>({ok:false,status:401})}),/no acepta el token/);
  await assert.rejects(fetchViewer(sources,'tok',{fetchImpl:async()=>({ok:false,status:500})}),/500/);
});
