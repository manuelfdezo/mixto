import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createManagedProject,discoverProjects,isInsideProjectsRoot,managedProjectPath,projectsRoot,syncDiscoveredProjects} from '../lib/projects.mjs';

test('the default projects root is a sibling of the Mixto repository',()=>{
  const app=path.join(path.parse(process.cwd()).root,'work','mixto');
  assert.equal(projectsRoot(app),path.join(path.parse(process.cwd()).root,'work','mixto-projects'));
});

test('projects are discovered from direct child folders without deleting stored projects',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mixto-projects-'));
  fs.mkdirSync(path.join(root,'tpv-papeleria'));
  fs.writeFileSync(path.join(root,'not-a-project.txt'),'x');
  const legacy={id:'legacy',name:'Legacy',path:path.join(root,'missing')};
  const data={projects:[legacy]};
  const result=syncDiscoveredProjects(data,root,()=> '2026-09-13T00:00:00.000Z');
  assert.equal(result.available,true);
  assert.deepEqual(result.projects.map(project=>project.directoryName),['tpv-papeleria']);
  assert.equal(data.projects[0],legacy);
  assert.equal(data.projects[1].name,'tpv-papeleria');
  assert.equal(data.projects[1].managed,true);
  fs.rmSync(root,{recursive:true,force:true});
});

test('managed project paths cannot traverse or escape through a directory link',t=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'mixto-root-'));
  const root=path.join(parent,'projects'),outside=path.join(parent,'outside');
  fs.mkdirSync(root);fs.mkdirSync(outside);
  assert.throws(()=>managedProjectPath(root,'../outside'),/Project folder/);
  assert.equal(isInsideProjectsRoot(root,outside),false);
  try {fs.symlinkSync(outside,path.join(root,'linked'),'junction');}
  catch {t.skip('directory links are not available in this environment');return;}
  assert.throws(()=>managedProjectPath(root,'linked'),/stay inside/);
  assert.deepEqual(discoverProjects(root).projects,[]);
  fs.rmSync(parent,{recursive:true,force:true});
});

test('creating a project only creates one direct child of an existing managed root',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mixto-create-'));
  const data={projects:[]};
  const project=createManagedProject(data,root,{name:'Paper shop POS',directoryName:'tpv-papeleria',description:'Sales'});
  assert.equal(project.path,fs.realpathSync(path.join(root,'tpv-papeleria')));
  assert.equal(project.managed,true);
  assert.ok(fs.statSync(project.path).isDirectory());
  assert.throws(()=>createManagedProject(data,root,{name:'Escape',directoryName:'..'}),/Project folder/);
  fs.rmSync(root,{recursive:true,force:true});
});
