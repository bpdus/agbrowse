// Real C++ client -> real Node Unix IPC -> SQLite service. The engine and token are synthetic.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {Store} from '../../../src/store.mjs';
import {SessionService} from '../../../src/service.mjs';
import {startIpcServer} from '../../../src/ipc.mjs';
const binary=process.env.MYBROWSE_NATIVE_IPC_TEST_BINARY;
const run=promisify(execFile);
test('C++ native framing reaches the daemon, sessions and finite event pages',{skip:process.platform==='darwin'&&binary?false:'requires compiled macOS native client'},async t=>{
 const token='c'.repeat(64);let starts=0;
 const service=new SessionService({store:new Store(':memory:','fixture'),engines:{codex:{start(){starts++;throw new Error('browser gate bypassed');}}}});
 const server=await startIpcServer({service,token,hostId:'fixture'});
 t.after(async()=>{await server.close();await service.close();});
 async function ask(op,payload={},auth=token){const id=randomUUID();const r=await run(binary,[server.socketPath,JSON.stringify({version:1,id,token:auth,op,payload}),'2000'],{timeout:5000});const data=JSON.parse(r.stdout);assert.equal(data.id,id);return data;}
 assert.equal((await ask('health')).data.capabilities.browser,false);
 assert.equal((await ask('list',{},'wrong-test-token')).error.status,401);
 const payload={prompt:'Native fixture browser request',engine:'codex',mode:'browser',client_id:'native-fixture',request_id:'create-one',host:'fixture'};
 const session=(await ask('create',payload)).data.session;
 assert.equal(session.status,'waiting_user');assert.equal(starts,0);
 assert.equal((await ask('create',payload)).data.session.id,session.id);
 const list=(await ask('list')).data;assert.equal(list.sessions.length,1);assert.equal(list.sessions[0].title,payload.prompt);assert.equal(Object.hasOwn(list.sessions[0],'result'),false);
 assert.equal((await ask('get',{id:session.id})).data.session.id,session.id);
 const first=(await ask('events',{id:session.id,after_seq:0,limit:1})).data;assert.equal(first.events.length,1);assert.equal(first.has_more,true);
 const second=(await ask('events',{id:session.id,after_seq:first.next_seq,limit:200})).data;assert.equal(second.has_more,false);assert.ok(second.events.every(e=>e.seq>first.next_seq));
});
