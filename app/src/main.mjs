import {mkdirSync,readFileSync,writeFileSync,chmodSync,renameSync,lstatSync,unlinkSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {acquireInstanceLock} from './instance-lock.mjs';
import {Store} from './store.mjs';
import {Broker} from './broker.mjs';
import {SessionService} from './service.mjs';
import {createHttpServer} from './http.mjs';
import {startIpcServer} from './ipc.mjs';
import {CodexDriver} from './engines/codex.mjs';
import {ClaudeDriver} from './engines/claude.mjs';

const data=resolve(process.env.MYBROWSE_DATA_DIR || '.mybrowse-data');
mkdirSync(data,{recursive:true,mode:0o700});chmodSync(data,0o700);
const releaseLock=acquireInstanceLock(join(data,'daemon.lock'));
process.on('exit',releaseLock);
const tokenPath=join(data,'token');let token;
try{token=readFileSync(tokenPath,'utf8').trim();}catch(e){if(e.code!=='ENOENT')throw e;token=randomBytes(32).toString('hex');writeFileSync(tokenPath,token+'\n',{mode:0o600,flag:'wx'});}
if(!/^[a-f0-9]{64}$/.test(token))throw new Error('invalid daemon token file');chmodSync(tokenPath,0o600);
const cwd=join(data,'engine-workspace');mkdirSync(cwd,{recursive:true,mode:0o700});
const hostId=process.env.MYBROWSE_HOST || 'macbook';
if(!/^[a-z0-9_-]{1,48}$/.test(hostId))throw new Error('invalid host ID');
const store=new Store(join(data,'sessions.db'),hostId);
const service=new SessionService({store,engines:{codex:new CodexDriver({cwd}),claude:new ClaudeDriver({cwd})},broker:new Broker(),browserReady:false});
const uiDir=resolve(dirname(fileURLToPath(import.meta.url)),'../ui');
const server=createHttpServer({service,token,hostId,uiDir});
const port=Number(process.env.MYBROWSE_PORT || 47371);
if(!Number.isInteger(port)||port<0||port>65535)throw new Error('invalid port');
let startupFailed=false;
let closing=false;
const connectionPath=join(data,'connection.json');
let connectionRecord;
process.on('SIGINT',close);process.on('SIGTERM',close);
const ipcPromise=startIpcServer({service,token,hostId,baseDir:process.env.MYBROWSE_IPC_BASE_DIR});
const ipc=await ipcPromise;
server.once('error',()=>{startupFailed=true;console.error(JSON.stringify({error:'http_listener_failed'}));void close();});
if(!closing)server.listen(port,'127.0.0.1',()=>{
 if(closing)return;
 const endpoint=`http://127.0.0.1:${server.address().port}`;
 const temporary=join(data,`.connection-${randomBytes(6).toString('hex')}.json`);
 const body=JSON.stringify({endpoint,host:hostId,ipc:{version:1,socket_path:ipc.socketPath}},null,2)+'\n';
 writeFileSync(temporary,body,{mode:0o600,flag:'wx'});
 const stat=lstatSync(temporary);
 renameSync(temporary,connectionPath);
 connectionRecord={dev:stat.dev,ino:stat.ino,body};
 console.log(JSON.stringify({endpoint,ui:endpoint+'/ui/',data,host:hostId,browser:false}));
});
async function close(){
 if(closing)return;closing=true;
 server.closeAllConnections();
 const httpClosed=new Promise(resolve=>server.close(resolve));
 const results=await Promise.allSettled([ipcPromise.then(socket=>socket.close()),service.close(),httpClosed]);
 let failed=startupFailed||results.some(result=>result.status==='rejected');
 if(connectionRecord){
  try{
   const stat=lstatSync(connectionPath);
   if(stat.isFile()&&stat.dev===connectionRecord.dev&&stat.ino===connectionRecord.ino&&stat.size===Buffer.byteLength(connectionRecord.body)&&readFileSync(connectionPath,'utf8')===connectionRecord.body)unlinkSync(connectionPath);
  }catch(error){if(error.code!=='ENOENT')failed=true;}
 }
 if(failed)console.error(JSON.stringify({error:'daemon_shutdown_failed'}));
 store.close();process.exit(failed?1:0);
}
