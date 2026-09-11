const url='http://127.0.0.1:4317';
try{
  const health=await(await fetch(url+'/api/health',{signal:AbortSignal.timeout(2000)})).json();
  if(health.app!=='mixto')throw new Error('El servicio local no es Mixto.');
  const root=await fetch(url+'/');const cookie=root.headers.get('set-cookie').split(';')[0];
  const result=await fetch(url+'/api/shutdown',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-Mixto-Client':'1'},body:'{}'});
  if(!result.ok)throw new Error('El servicio no aceptó el cierre.');
  console.log('Mixto se ha cerrado. Tus conversaciones y recuerdos siguen guardados.');
}catch(e){console.log('Mixto no está abierto o no se pudo cerrar: '+e.message);}
