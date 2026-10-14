// Actual macOS C++ executable and real Unix sockets. Credentials and engine calls are test fixtures.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtempSync,chmodSync,rmSync,symlinkSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
const binary=process.env.MYBROWSE_NATIVE_IPC_TEST_BINARY;
const enabled=process.platform==='darwin'&&binary;
const run=promisify(execFile);
const frame=body=>{const b=Buffer.from(body),h=Buffer.alloc(4);h.writeUInt32BE(b.length);return Buffer.concat([h,b]);};
async function fixture(t,onRequest){
 const dir=mkdtempSync('/private/tmp/mybrowse-native-test-');chmodSync(dir,0o700);
 const socketPath=path.join(dir,'daemon.sock');const clients=new Set();let received=0;
 const server=net.createServer({allowHalfOpen:true},s=>{clients.add(s);s.on('error',()=>{});s.on('close',()=>clients.delete(s));const chunks=[];s.on('data',b=>{received+=b.length;chunks.push(b);});s.on('end',()=>onRequest(s,Buffer.concat(chunks)));});
 await new Promise((r,j)=>{server.once('error',j);server.listen(socketPath,r);});chmodSync(socketPath,0o600);
 t.after(async()=>{for(const s of clients)s.destroy();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});});
 return {dir,socketPath,received:()=>received};
}
async function call(socketPath,timeout=1000,body='{"test":"native"}'){
 try{const r=await run(binary,[socketPath,body,String(timeout)],{timeout:timeout+2000,maxBuffer:2*1024*1024});return {code:0,body:r.stdout};}
 catch(e){if(e.killed||e.code!=='1'&&e.code!==1)throw e;return {code:1,error:Number(e.stderr.trim()),body:e.stdout};}
}
function check(name,fn){test(name,{skip:enabled?false:'requires macOS and compiled MYBROWSE_NATIVE_IPC_TEST_BINARY'},fn);}
check('real UID, complete request and fragmented framed response',async t=>{
 const response='{"ok":true,"text":"네이티브 왕복"}';
 const f=await fixture(t,(s,b)=>{assert.equal(b.readUInt32BE(),b.length-4);assert.equal(b.subarray(4).toString(),'{"test":"native"}');const out=frame(response);s.write(out.subarray(0,2));setTimeout(()=>{s.write(out.subarray(2,7));setTimeout(()=>s.end(out.subarray(7)),20);},20);});
 const r=await call(f.socketPath);assert.deepEqual(r,{code:0,body:response});assert.ok(f.received()>4);
});
for(const [name,data,error] of [
 ['zero length',Buffer.alloc(4),6],['oversized length',Buffer.from([0,0x10,0,1]),7],
 ['short header',Buffer.from([0,0]),6],['short body',Buffer.from([0,0,0,4,65]),6],
 ['trailing byte',Buffer.concat([frame('ok'),Buffer.from([0])]),6],
 ['second frame',Buffer.concat([frame('ok'),frame('other')]),6],
])check(name+' is rejected',async t=>{const f=await fixture(t,s=>s.end(data));const r=await call(f.socketPath);assert.equal(r.error,error);assert.equal(r.body,'');});
check('deadline applies while waiting for body',async t=>{const f=await fixture(t,s=>s.write(Buffer.from([0,0,0,5,65])));const start=performance.now();const r=await call(f.socketPath,120);assert.equal(r.error,5);assert.ok(performance.now()-start<1500);});
check('deadline applies after full response without EOF',async t=>{const f=await fixture(t,s=>s.write(frame('ok')));const r=await call(f.socketPath,120);assert.equal(r.error,5);});
check('deadline is total across fragmented progress',async t=>{const f=await fixture(t,s=>{s.write(Buffer.from([0,0,0,5]));const timer=setInterval(()=>s.write('x'),50);s.on('close',()=>clearInterval(timer));});const r=await call(f.socketPath,130);assert.equal(r.error,5);});
check('unsafe parent is rejected before request',async t=>{const f=await fixture(t,s=>s.end(frame('bad')));chmodSync(f.dir,0o755);const r=await call(f.socketPath);assert.equal(r.error,2);assert.equal(f.received(),0);});
check('unsafe socket is rejected before request',async t=>{const f=await fixture(t,s=>s.end(frame('bad')));chmodSync(f.socketPath,0o666);const r=await call(f.socketPath);assert.equal(r.error,2);assert.equal(f.received(),0);});
check('symlink socket is rejected before request',async t=>{const f=await fixture(t,s=>s.end(frame('bad')));const p=path.join(f.dir,'alias.sock');symlinkSync(f.socketPath,p);const r=await call(p);assert.equal(r.error,2);assert.equal(f.received(),0);});
check('symlink parent is rejected before request',async t=>{const f=await fixture(t,s=>s.end(frame('bad')));const alias=f.dir+'-alias';symlinkSync(f.dir,alias);t.after(()=>rmSync(alias));const r=await call(alias+'/daemon.sock');assert.equal(r.error,2);assert.equal(f.received(),0);});
check('invalid input is rejected',async()=>{for(const p of ['relative.sock','/private/tmp//s','/private/tmp/../s','/'+ 'x'.repeat(104)])assert.equal((await call(p)).error,1);assert.equal((await call('/private/tmp/s',0)).error,1);assert.equal((await call('/private/tmp/s',60001)).error,1);assert.equal((await call('/private/tmp/s',1000,'')).error,1);});
check('peer closes early without crashing the client',async t=>{const f=await fixture(t,s=>s.destroy());const r=await call(f.socketPath);assert.equal(r.code,1);assert.ok([3,6].includes(r.error));});
