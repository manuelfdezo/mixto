import {createInterface} from 'node:readline';
const provider=process.argv[2];
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
let prompt='';
function codexDone(text='Respuesta verificada: áéñ'){
  send({method:'item/agentMessage/delta',params:{itemId:'m1',delta:text.slice(0,8)}});
  send({method:'item/agentMessage/delta',params:{itemId:'m1',delta:text.slice(8)}});
  send({method:'item/completed',params:{item:{id:'m1',type:'agentMessage',text}}});
  send({method:'turn/completed',params:{turn:{id:'turn1',status:'completed'}}});
}
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(provider==='codex'){
   if(m.method==='initialize')send({id:m.id,result:{}});
   if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:m.params.threadId||'native-codex'}}});
   if(m.method==='turn/start'){
     prompt=m.params.input[0].text;send({id:m.id,result:{turn:{id:'turn1'}}});
     if(prompt==='ERROR')return send({method:'turn/completed',params:{turn:{status:'failed',error:{message:'Fallo controlado'}}}});
     if(prompt==='WAIT')return;
     if(prompt==='PERMISSION')return send({id:99,method:'item/commandExecution/requestApproval',params:{threadId:'native-codex',turnId:'turn1',command:'echo test',cwd:process.cwd()}});
     codexDone();
   }
   if(m.id===99&&m.result)codexDone(m.result.decision==='accept'?'Permitido':'Rechazado');
 }else{
   if(m.type==='control_request'&&m.request.subtype==='initialize')send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:[]}}});
   if(m.type==='user'){
     prompt=m.message.content;
     send({type:'system',subtype:'init',session_id:'native-claude'});
     if(prompt==='ERROR')return send({type:'result',is_error:true,errors:['Fallo controlado']});
     if(prompt==='WAIT')return;
     if(prompt==='PERMISSION')return send({type:'control_request',request_id:'permission1',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'echo test'}}});
     send({type:'stream_event',event:{delta:{type:'text_delta',text:'Respuesta '}}});
     send({type:'assistant',message:{content:[{type:'text',text:'Respuesta verificada: áéñ'}]}});
     send({type:'result',is_error:false,result:'Respuesta verificada: áéñ',session_id:'native-claude'});
   }
   if(m.type==='control_response'&&m.response.request_id==='permission1')send({type:'result',is_error:false,result:m.response.response.behavior==='allow'?'Permitido':'Rechazado',session_id:'native-claude'});
 }
});
