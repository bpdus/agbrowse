// Real daemon processes and Unix sockets. No engine request or model credentials are used.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,unlinkSync,existsSync,rmSync,lstatSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function daemon(t,port='0'){
 const data=mkdtempSync(path.join(root,'.daemon-test-'));
 const ipcBase=mkdtempSync('/private/tmp/mybrowse-daemon-test-');
 const child=spawn(process.execPath,[path.join(root,'src/main.mjs')],{cwd:root,env:{...process.env,MYBROWSE_DATA_DIR:data,MYBROWSE_PORT:port,MYBROWSE_IPC_BASE_DIR:ipcBase},stdio:['ignore','pipe','pipe']});
 let output='',stderr='',exited;
 child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>stderr+=b);
 const closed=new Promise(r=>child.once('close',(code,signal)=>{exited={code,signal};r(exited);}));
 t.after(async()=>{if(!exited){child.kill('SIGTERM');await Promise.race([closed,new Promise(r=>setTimeout(r,3000))]);if(!exited){child.kill('SIGKILL');await closed;}}rmSync(data,{recursive:true,force:true});rmSync(ipcBase,{recursive:true,force:true});});
 await new Promise((r,j)=>{const start=Date.now();const timer=setInterval(()=>{if(output.includes('\n')||exited){clearInterval(timer);r();}else if(Date.now()-start>5000){clearInterval(timer);j(new Error('daemon did not become ready'));}},10);});
 return {data,ipcBase,child,closed,output,stderr,get exited(){return exited;}};
}
test('daemon publishes private IPC metadata and removes owned connection on shutdown',async t=>{
 const d=await daemon(t);assert.ok(d.output.includes('\n'));const p=path.join(d.data,'connection.json'),c=JSON.parse(readFileSync(p));
 assert.equal(lstatSync(p).mode&511,384);assert.equal(c.ipc.version,1);assert.equal(lstatSync(c.ipc.socket_path).mode&511,384);
 d.child.kill('SIGTERM');assert.deepEqual(await d.closed,{code:0,signal:null});
 assert.equal(existsSync(p),false);assert.equal(existsSync(c.ipc.socket_path),false);assert.equal(existsSync(path.join(d.data,'daemon.lock')),false);assert.equal(existsSync(path.join(d.data,'token')),true);
});
for(const replacement of ['new inode','changed content'])test('daemon preserves connection file with '+replacement,async t=>{
 const d=await daemon(t),p=path.join(d.data,'connection.json');const c=JSON.parse(readFileSync(p));
 if(replacement==='new inode')unlinkSync(p);writeFileSync(p,'foreign metadata');
 d.child.kill('SIGTERM');assert.equal((await d.closed).code,0);assert.equal(readFileSync(p,'utf8'),'foreign metadata');assert.equal(existsSync(c.ipc.socket_path),false);
});
test('HTTP bind failure cleans the owned IPC listener and exits',async t=>{
 const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>s.close(r)));
 const d=await daemon(t,String(s.address().port));assert.equal((await d.closed).code,1);assert.equal(existsSync(path.join(d.data,'connection.json')),false);assert.equal(existsSync(path.join(d.data,'daemon.lock')),false);assert.ok(d.stderr.includes('http_listener_failed'));assert.deepEqual(readdirSync(d.ipcBase),[]);
});
