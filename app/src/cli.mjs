#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';

async function main(){
const {values,positionals}=parseArgs({allowPositionals:true,options:{engine:{type:'string',default:'codex'},mode:{type:'string',default:'browser'},host:{type:'string'},request:{type:'string'},revision:{type:'string'},'no-wait':{type:'boolean',default:false},help:{type:'boolean',short:'h'}}});
const help=`mybrowse exec "작업" [--engine codex|claude] [--mode browser|chat] [--no-wait]
mybrowse session list | log <id> | steer <id> "지시" | queue <id> "지시" | resume <id> "지시" | stop <id>
mybrowse auth token
mybrowse tab / repl / shot: Chromium 연결 후 활성화합니다.
데이터: MYBROWSE_DATA_DIR. 원격: MYBROWSE_ENDPOINT=https://<host>.ts.net + MYBROWSE_TOKEN.`;
if(values.help||!positionals.length){console.log(help);process.exit(0);}
const data=resolve(process.env.MYBROWSE_DATA_DIR || '.mybrowse-data');
if(positionals[0]==='auth'&&positionals[1]==='token'){process.stdout.write(readFileSync(join(data,'token'),'utf8'));process.exit(0);}
let connection;
try{connection=JSON.parse(readFileSync(join(data,'connection.json'),'utf8'));}catch{connection={};}
const endpoint=process.env.MYBROWSE_ENDPOINT || connection.endpoint;
if(!endpoint)throw new Error('데몬을 먼저 실행하세요: npm start');
const url=new URL(endpoint);
if(!((url.protocol==='http:'&&url.hostname==='127.0.0.1')||(url.protocol==='https:'&&url.hostname.endsWith('.ts.net')))||url.username||url.password||url.search||url.hash)throw new Error('localhost 또는 명시한 tailnet HTTPS만 지원합니다.');
const token=process.env.MYBROWSE_TOKEN || readFileSync(join(data,'token'),'utf8').trim();
const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
async function api(path,body){const r=await fetch(endpoint+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});const x=await r.json();if(!r.ok)throw new Error(x.error?.message || x.error || `HTTP ${r.status}`);return x;}
async function follow(id){
 const abort=new AbortController();let poll;
 const terminal=new Set(['done','failed','paused','waiting_user','waiting_provider','uncertain']);
 try{
  const r=await fetch(`${endpoint}/v1/sessions/${encodeURIComponent(id)}/events?after_seq=0`,{headers,signal:abort.signal});
  if(!r.ok)throw new Error(`HTTP ${r.status}`);
  poll=setInterval(async()=>{try{const x=await api('/v1/sessions/'+encodeURIComponent(id));if(terminal.has(x.session.status))abort.abort();}catch{abort.abort();}},500);
  const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='';
  while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let pos;
   while((pos=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,pos);buffer=buffer.slice(pos+2);for(const line of block.split('\n'))if(line.startsWith('data:'))console.log(line.slice(5).trim());}
  }
 }catch(e){if(e.name!=='AbortError')throw e;}finally{clearInterval(poll);abort.abort();}
 const x=await api('/v1/sessions/'+encodeURIComponent(id));console.log(JSON.stringify({session:x.session}));
 if(x.session.status!=='done')process.exitCode=x.session.status==='failed'?1:2;
}
try{
 const [group,action,id,...texts]=positionals;
 if(group==='exec'){
  const health=await api('/health');const {session}=await api('/v1/sessions',{prompt:positionals.slice(1).join(' '),engine:values.engine,mode:values.mode,host:values.host||health.host,client_id:'mybrowse-cli',request_id:values.request||randomUUID()});
  console.log(JSON.stringify({id:session.id,status:session.status,host:session.host}));if(!values['no-wait'])await follow(session.id);
 }else if(group==='session'){
  if(action==='list')console.log(JSON.stringify(await api('/v1/sessions'),null,2));
  else if(action==='log'){if(!id)throw new Error('세션 ID가 필요합니다.');await follow(id);}
  else if(['steer','queue','resume','stop'].includes(action)){
   if(!id)throw new Error('세션 ID가 필요합니다.');
   if(values.request && values.revision===undefined)throw new Error('--request 재전송에는 원래 --revision이 필요합니다.');
   const {session}=await api('/v1/sessions/'+encodeURIComponent(id));
   console.log(JSON.stringify(await api('/v1/sessions/'+encodeURIComponent(id)+'/commands',{action,text:texts.join(' '),expected_revision:values.revision===undefined?session.revision:Number(values.revision),request_id:values.request||randomUUID()}),null,2));
  }else throw new Error(help);
 }else if(['tab','repl','shot'].includes(group))throw new Error('browser_not_integrated: 독립 Chromium과 MCP 연결이 필요합니다.');
 else throw new Error(help);
}catch(e){console.error(e.message);process.exitCode=1;}

}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
