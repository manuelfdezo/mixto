// Comandos permitidos por proyecto: un prefijo por línea. «npm test» permite «npm test» y «npm test -- x»,
// nunca «npm testing». Sirve para aprobar automáticamente lo que los agentes piden ejecutar y para
// adelantárselo a Claude Code como herramientas permitidas.
export const normalizeCommand=value=>String(value||'').replace(/\s+/g,' ').trim();

export function commandAllowed(list,command) {
  const cmd=normalizeCommand(command);
  if(!cmd)return false;
  return (Array.isArray(list)?list:[]).some(entry=>{
    const prefix=normalizeCommand(entry);
    return !!prefix&&(cmd===prefix||cmd.startsWith(prefix+' '));
  });
}

// Lo que se guarda al pulsar «permitir siempre»: las dos primeras palabras («npm test», «git status»).
export function commandPrefix(command) {
  const words=normalizeCommand(command).split(' ').filter(Boolean);
  return words.slice(0,2).join(' ');
}

export function cleanCommandList(list) {
  const seen=new Set();const out=[];
  for(const entry of Array.isArray(list)?list:[]) {
    if(typeof entry!=='string')continue;
    const prefix=normalizeCommand(entry).slice(0,200);
    if(!prefix||seen.has(prefix))continue;
    seen.add(prefix);out.push(prefix);
    if(out.length>=100)break;
  }
  return out;
}

// Patrones de permisos de Claude Code para los mismos prefijos, en las dos sintaxis que admite.
export const claudeAllowedTools=list=>cleanCommandList(list).flatMap(prefix=>[`Bash(${prefix})`,`Bash(${prefix}:*)`,`Bash(${prefix} *)`]);

// Un error al reanudar una sesión nativa que ya no existe: se reintenta una vez sin sesión.
export const looksLikeSessionLoss=error=>/session|thread|resume|conversation|not found|no such|unknown|invalid|expired/i.test(String(error?.message||''));
