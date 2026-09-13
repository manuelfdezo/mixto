import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const defaultDir=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','agents');
const cache=new Map();

// A hand-rolled parser is enough: the frontmatter is always flat `key: value` lines, never nested.
function frontmatter(raw){
  const match=/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if(!match)return null;
  const meta={};
  for(const line of match[1].split(/\r?\n/)){
    const colon=line.indexOf(':');
    if(colon<0)continue;
    const key=line.slice(0,colon).trim();
    let value=line.slice(colon+1).trim();
    if(/^".*"$/.test(value)||/^'.*'$/.test(value))value=value.slice(1,-1);
    if(key)meta[key]=value;
  }
  return {meta,body:match[2].trim()};
}

// A missing folder, a file that fails to read, or one without a usable name is skipped, never thrown.
function load(dir){
  if(cache.has(dir))return cache.get(dir);
  const entries=[];
  let files=[];
  try{files=fs.readdirSync(dir).filter(name=>name.endsWith('.md'));}catch{files=[];}
  for(const file of files){
    try{
      const parsed=frontmatter(fs.readFileSync(path.join(dir,file),'utf8'));
      if(!parsed?.meta.name)continue;
      entries.push({id:path.basename(file,'.md'),name:parsed.meta.name,
        description:parsed.meta.description||'',emoji:parsed.meta.emoji||'',body:parsed.body});
    }catch{continue;}
  }
  cache.set(dir,entries);
  return entries;
}

export function listPersonas(dir=defaultDir){
  return load(dir).map(({id,name,description,emoji})=>({id,name,description,emoji}));
}

export function personaBody(id,dir=defaultDir){
  if(!id)return '';
  return load(dir).find(persona=>persona.id===id)?.body||'';
}
