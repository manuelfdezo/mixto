import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const provider=process.argv[2];
const args=provider==='codex'?['app-server']:['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--permission-prompt-tool','stdio'];
const child=spawn(provider,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
const timer=setTimeout(()=>{console.log('probe timeout');child.kill();},25000);
child.stderr.on('data',d=>process.stderr.write(d));
const send=m=>child.stdin.write(JSON.stringify(m)+'\n');
createInterface({input:child.stdout}).on('line',line=>{
 try{ const m=JSON.parse(line);
 if(provider==='codex'){
   if(m.id===1){send({method:'initialized',params:{}});send({id:2,method:'model/list',params:{includeHidden:true,limit:100}});}
   if(m.id===2){console.log(JSON.stringify(m));send({id:3,method:'account/rateLimits/read',params:{}});}
   // La forma de la cuota no está fijada por contrato: imprímela para comprobar que Mixto la interpreta.
   if(m.id===3){console.log(JSON.stringify(m)); child.kill();}
 }else{ console.log(JSON.stringify(m)); if(m.type==='control_response')child.kill(); }
 }catch{console.log(line);}
});
child.on('error',e=>console.error(e.message));
child.on('exit',()=>clearTimeout(timer));
if(provider==='codex')send({id:1,method:'initialize',params:{clientInfo:{name:'mixto',title:'Mixto',version:'1.0.0'}}});
else send({type:'control_request',request_id:'init-mixto',request:{subtype:'initialize'}});
