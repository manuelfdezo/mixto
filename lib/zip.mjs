// Lector y escritor mínimos de zip, sin dependencias: lo justo para descargar una versión de Mixto
// (entradas almacenadas o deflate, sin ZIP64 ni cifrado) y para fabricar zips pequeños en las pruebas.
import zlib from 'node:zlib';

const CRC_TABLE=new Int32Array(256);
for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;CRC_TABLE[n]=c;}
export function crc32(buffer){let c=-1;for(let i=0;i<buffer.length;i++)c=CRC_TABLE[(c^buffer[i])&0xff]^(c>>>8);return (c^-1)>>>0;}

const SIG_EOCD=0x06054b50,SIG_CENTRAL=0x02014b50,SIG_LOCAL=0x04034b50;

// Solo rutas relativas, con barras normales y sin «..»: nada puede escribir fuera de la carpeta destino.
export function safeEntryName(name){
  if(typeof name!=='string'||!name||name.includes('\\')||name.includes('\0'))return null;
  if(/^([a-zA-Z]:|\/)/.test(name))return null;
  if(name.split('/').some(part=>part==='..'))return null;
  return name;
}

export function extractZip(buffer,{maxEntries=20000,maxTotal=200*1024*1024}={}) {
  if(!Buffer.isBuffer(buffer)||buffer.length<22)throw new Error('El archivo no es un zip.');
  let eocd=-1;
  for(let i=buffer.length-22;i>=Math.max(0,buffer.length-22-65535);i--){if(buffer.readUInt32LE(i)===SIG_EOCD){eocd=i;break;}}
  if(eocd<0)throw new Error('El archivo no es un zip.');
  const count=buffer.readUInt16LE(eocd+10),size=buffer.readUInt32LE(eocd+12),offset=buffer.readUInt32LE(eocd+16);
  if(count===0xffff||size===0xffffffff||offset===0xffffffff)throw new Error('Zip64 no admitido.');
  if(count>maxEntries)throw new Error('El zip tiene demasiadas entradas.');
  const entries=[];let position=offset,total=0;
  for(let n=0;n<count;n++){
    if(position+46>buffer.length||buffer.readUInt32LE(position)!==SIG_CENTRAL)throw new Error('Directorio del zip dañado.');
    const flags=buffer.readUInt16LE(position+8),method=buffer.readUInt16LE(position+10),crc=buffer.readUInt32LE(position+16);
    const compressed=buffer.readUInt32LE(position+20),uncompressed=buffer.readUInt32LE(position+24);
    const nameLength=buffer.readUInt16LE(position+28),extraLength=buffer.readUInt16LE(position+30),commentLength=buffer.readUInt16LE(position+32);
    const externalAttrs=buffer.readUInt32LE(position+38),localOffset=buffer.readUInt32LE(position+42);
    const rawName=buffer.subarray(position+46,position+46+nameLength).toString('utf8');
    position+=46+nameLength+extraLength+commentLength;
    if(flags&0x1)throw new Error('El zip está cifrado.');
    const name=safeEntryName(rawName);
    if(!name)throw new Error(`Ruta no permitida dentro del zip: ${rawName}`);
    const unixMode=(externalAttrs>>>16)&0xffff;
    if((unixMode&0xF000)===0xA000)continue; // los enlaces simbólicos se quedan fuera
    if(name.endsWith('/')||(unixMode&0xF000)===0x4000){entries.push({name,dir:true,data:null,mode:unixMode});continue;}
    if(localOffset+30>buffer.length||buffer.readUInt32LE(localOffset)!==SIG_LOCAL)throw new Error('Entrada del zip dañada.');
    const dataStart=localOffset+30+buffer.readUInt16LE(localOffset+26)+buffer.readUInt16LE(localOffset+28);
    if(dataStart+compressed>buffer.length)throw new Error('Entrada del zip truncada.');
    const raw=buffer.subarray(dataStart,dataStart+compressed);
    let data;
    if(method===0)data=Buffer.from(raw);
    else if(method===8)data=zlib.inflateRawSync(raw,{maxOutputLength:Math.max(uncompressed,1)});
    else throw new Error(`Método de compresión no admitido (${method}).`);
    if(data.length!==uncompressed||crc32(data)!==crc)throw new Error(`Contenido dañado en ${name}.`);
    total+=data.length;if(total>maxTotal)throw new Error('El zip es demasiado grande.');
    entries.push({name,dir:false,data,mode:unixMode});
  }
  return entries;
}

// Zip sin comprimir a partir de {name,data,dir}: suficiente para pruebas y copias pequeñas.
export function buildZip(files){
  const locals=[],centrals=[];let offset=0;
  for(const {name,data=Buffer.alloc(0),dir=false} of files){
    const entryName=dir&&!name.endsWith('/')?name+'/':name;
    const nameBuffer=Buffer.from(entryName,'utf8'),content=dir?Buffer.alloc(0):Buffer.from(data);
    const crc=crc32(content);
    const local=Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(0,8);
    local.writeUInt16LE(0,10);local.writeUInt16LE(0x21,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(content.length,18);local.writeUInt32LE(content.length,22);
    local.writeUInt16LE(nameBuffer.length,26);local.writeUInt16LE(0,28);
    const central=Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL,0);central.writeUInt16LE(0x031e,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);
    central.writeUInt16LE(0,10);central.writeUInt16LE(0,12);central.writeUInt16LE(0x21,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(content.length,20);central.writeUInt32LE(content.length,24);
    central.writeUInt16LE(nameBuffer.length,28);central.writeUInt16LE(0,30);central.writeUInt16LE(0,32);central.writeUInt16LE(0,34);central.writeUInt16LE(0,36);
    central.writeUInt32LE(((dir?0x41ed:0x81a4)<<16)>>>0,38);central.writeUInt32LE(offset,42);
    locals.push(local,nameBuffer,content);centrals.push(central,nameBuffer);
    offset+=local.length+nameBuffer.length+content.length;
  }
  const centralBuffer=Buffer.concat(centrals);
  const eocd=Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD,0);eocd.writeUInt16LE(0,4);eocd.writeUInt16LE(0,6);eocd.writeUInt16LE(files.length,8);eocd.writeUInt16LE(files.length,10);
  eocd.writeUInt32LE(centralBuffer.length,12);eocd.writeUInt32LE(offset,16);eocd.writeUInt16LE(0,20);
  return Buffer.concat([...locals,centralBuffer,eocd]);
}
