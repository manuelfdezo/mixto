import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const samePath=(left,right)=>process.platform==='win32'
  ? left.toLocaleLowerCase()===right.toLocaleLowerCase()
  : left===right;

export function projectsRoot(appRoot,configured=process.env.MIXTO_PROJECTS_ROOT) {
  return path.resolve(configured||path.join(appRoot,'..','mixto-projects'));
}

function canonicalDirectory(directory) {
  const canonical=fs.realpathSync(directory);
  if(!fs.statSync(canonical).isDirectory())throw new Error('The path must be a directory.');
  return canonical;
}

export function isInsideProjectsRoot(root,candidate) {
  const relative=path.relative(root,candidate);
  return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);
}

export function managedProjectPath(root,directoryName,{mustExist=true}={}) {
  if(typeof directoryName!=='string'||!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(directoryName))
    throw new Error('Project folder: use letters, numbers, dots, hyphens or underscores.');
  const canonicalRoot=canonicalDirectory(root);
  const candidate=path.join(canonicalRoot,directoryName);
  if(!isInsideProjectsRoot(canonicalRoot,candidate))throw new Error('The project must stay inside the managed projects folder.');
  if(!mustExist)return candidate;
  const canonical=canonicalDirectory(candidate);
  if(!isInsideProjectsRoot(canonicalRoot,canonical))throw new Error('The project must stay inside the managed projects folder.');
  return canonical;
}

export function discoverProjects(root) {
  if(!fs.existsSync(root))return {available:false,root:path.resolve(root),projects:[]};
  const canonicalRoot=canonicalDirectory(root);
  const projects=[];
  for(const entry of fs.readdirSync(canonicalRoot,{withFileTypes:true})) {
    if(!entry.isDirectory())continue;
    try {
      const projectPath=managedProjectPath(canonicalRoot,entry.name);
      projects.push({directoryName:entry.name,path:projectPath});
    } catch {}
  }
  projects.sort((a,b)=>a.directoryName.localeCompare(b.directoryName,undefined,{sensitivity:'base'}));
  return {available:true,root:canonicalRoot,projects};
}

export function syncDiscoveredProjects(data,root,stamp=()=>new Date().toISOString()) {
  const discovered=discoverProjects(root);
  const added=[];
  for(const item of discovered.projects) {
    if(data.projects.some(project=>samePath(project.path,item.path)))continue;
    const project={id:randomUUID(),name:item.directoryName,path:item.path,description:'',createdAt:stamp(),managed:true,directoryName:item.directoryName};
    data.projects.push(project);added.push(project);
  }
  return {...discovered,added};
}

export function createManagedProject(data,root,{name,directoryName,description=''}) {
  if(typeof name!=='string'||!name.trim()||name.length>80)throw new Error('Name: enter up to 80 characters.');
  if(typeof description!=='string'||description.length>2000)throw new Error('Description: enter up to 2000 characters.');
  const candidate=managedProjectPath(root,directoryName,{mustExist:false});
  if(!fs.existsSync(candidate))fs.mkdirSync(candidate);
  const projectPath=managedProjectPath(root,directoryName);
  const existing=data.projects.find(project=>samePath(project.path,projectPath));
  if(existing)return existing;
  const project={id:randomUUID(),name:name.trim(),path:projectPath,description:description.trim(),createdAt:new Date().toISOString(),managed:true,directoryName};
  data.projects.push(project);
  return project;
}
