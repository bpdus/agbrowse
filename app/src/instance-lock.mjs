import {openSync,writeFileSync,readFileSync,closeSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
export function acquireInstanceLock(path) {
 const nonce=randomUUID();let fd;
 try{fd=openSync(path,'wx',0o600);}catch(e){
  if(e.code==='EEXIST')throw new Error('another MyBrowse daemon or stale lock owns this data folder; inspect daemon.lock');
  throw e;
 }
 try{writeFileSync(fd,JSON.stringify({pid:process.pid,nonce}));}finally{closeSync(fd);}
 return ()=>{try{const current=JSON.parse(readFileSync(path,'utf8'));if(current.nonce===nonce)unlinkSync(path);}catch(e){if(e.code!=='ENOENT')throw e;}};
}
