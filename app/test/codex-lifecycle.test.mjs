import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {CodexDriver} from '../src/engines/codex.mjs';
function server({deferAccount=false,earlyComplete=false,approval=false}={}){
 const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.stdin=new PassThrough();c.exitCode=null;c.signalCode=null;const calls=[];
 const send=m=>c.stdout.write(JSON.stringify(m)+'\n');
 c.kill=()=>{calls.push('kill');queueMicrotask(()=>{c.signalCode='SIGTERM';c.emit('exit',null,'SIGTERM');c.emit('close',null,'SIGTERM');});};
 let buffer='';c.stdin.on('data',bytes=>{buffer+=bytes;let i;while((i=buffer.indexOf('\n'))>=0){const m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(!m.method)continue;calls.push(m.method);if(m.id===undefined)continue;
  if(m.method==='account/read'&&deferAccount)continue;
  let result={};if(m.method==='account/read')result={account:{type:'chatgpt'}};
  if(m.method==='thread/start')result={thread:{id:'official-thread'}};
  if(m.method==='turn/start'){
   send({method:'turn/started',params:{threadId:'official-thread',turn:{id:'official-turn'}}});
   if(approval)send({id:900,method:'item/commandExecution/requestApproval',params:{}});
   if(earlyComplete){send({method:'item/agentMessage/delta',params:{threadId:'official-thread',delta:'OK'}});send({method:'turn/completed',params:{threadId:'official-thread',turn:{id:'official-turn',status:'completed'}}});}
   result={turn:{id:'official-turn'}};
  }
  queueMicrotask(()=>send({id:m.id,result}));
 }});return {c,calls};
}
function cb(controller,ends=[],waits=[]){return{signal:controller.signal,onEvent:()=>{},onId:()=>{},onEnd:x=>ends.push(x),onWaiting:r=>{waits.push(r);controller.abort();}};}
test('Codex abort sends interrupt and stop waits for the owned process to exit',async()=>{
 const {c,calls}=server(),signal=new AbortController();const driver=new CodexDriver({spawnProcess:()=>c,getOverrides:()=>[]});
 const handle=await driver.start({prompt:'hi'},cb(signal));signal.abort();await handle.stop();
 assert.ok(calls.indexOf('turn/interrupt')<calls.indexOf('kill'));assert.equal(c.signalCode,'SIGTERM');assert.equal(calls.filter(x=>x==='kill').length,1);
});
test('Codex cancellation during startup never starts a model turn',async()=>{
 const {c,calls}=server({deferAccount:true}),signal=new AbortController();const driver=new CodexDriver({spawnProcess:()=>c,getOverrides:()=>[]});
 const start=driver.start({prompt:'hi'},cb(signal));await new Promise(r=>setImmediate(r));signal.abort();const h=await start;await h.stop();assert.ok(!calls.includes('thread/start'));assert.ok(!calls.includes('turn/start'));
});
test('completion before turn/start response remains done after process cleanup',async()=>{
 const {c}=server({earlyComplete:true}),ends=[],signal=new AbortController();
 await new CodexDriver({spawnProcess:()=>c,getOverrides:()=>[]}).start({prompt:'hi'},cb(signal,ends));await new Promise(r=>setImmediate(r));
 assert.deepEqual(ends,[{status:'done',result:'OK'}]);assert.equal(c.signalCode,'SIGTERM');
});
test('Codex approval is refused and waits for user without reporting success',async()=>{
 const {c}=server({approval:true}),ends=[],waits=[],signal=new AbortController();
 const h=await new CodexDriver({spawnProcess:()=>c,getOverrides:()=>[]}).start({prompt:'hi'},cb(signal,ends,waits));await h.stop();
 assert.equal(waits.length,1);assert.match(waits[0],/approval_required/);assert.equal(ends.length,0);
});
