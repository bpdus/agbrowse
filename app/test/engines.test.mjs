import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cliEnvironment,codexOverrides} from '../src/engines/environment.mjs';
import {StdioRpc} from '../src/engines/rpc.mjs';
import {ClaudeDriver} from '../src/engines/claude.mjs';
function child(){const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.stdin=new PassThrough();c.exitCode=null;c.signalCode=null;c.kill=()=>{c.signalCode='SIGTERM';queueMicrotask(()=>c.emit('exit',null,'SIGTERM'));};return c;}
test('provider keys/proxies and injected Node options never reach a child',()=>{
 assert.deepEqual(cliEnvironment({HOME:'/h',PATH:'/bin',OPENAI_API_KEY:'fake',ANTHROPIC_API_KEY:'fake',HTTP_PROXY:'evil',NODE_OPTIONS:'evil',CLAUDECODE:'1',CODEX_HOME:'/other'}),{HOME:'/h',PATH:'/bin'});
});
test('Codex disables existing named MCP without modifying global config',()=>{
 const d=mkdtempSync(join(tmpdir(),'mybrowse-config-'));mkdirSync(join(d,'.codex'));
 const file=join(d,'.codex/config.toml');writeFileSync(file,'[mcp_servers.browser]\ncommand="node"\n');
 assert.ok(codexOverrides(d).includes('mcp_servers.browser.enabled=false'));
 writeFileSync(file,'[model_providers.openai]\nbase_url="http://router"\n');assert.throws(()=>codexOverrides(d),/unsupported_global_config/);
 rmSync(d,{recursive:true});
});
test('RPC rejects pending calls when app-server exits',async()=>{
 const c=child(),r=new StdioRpc(c);const p=r.request('initialize');c.emit('exit',1,null);await assert.rejects(p,/exited/);assert.equal(r.pending.size,0);
});
test('RPC uses actual response ID and expires a stalled call',async()=>{
 const c=child(),r=new StdioRpc(c,{timeout:15});const p=r.request('example');c.stdout.write('{"id":1,"result":{"ok":true}}\n');assert.deepEqual(await p,{ok:true});await assert.rejects(r.request('stall'),/timeout/);r.close();
});
test('Claude refuses API auth before any model process is launched',async()=>{
 let called=false,waiting;
 const d=new ClaudeDriver({checkAuth:async()=>false,spawnProcess:()=>{called=true;}});
 await d.start({prompt:'hi'},{onWaiting:r=>waiting=r});assert.equal(called,false);assert.match(waiting,/subscription/);
});
test('Claude stores official ID, resumes it, and stop suppresses late results',async()=>{
 const c=child();let argv;const events=[],ids=[],ends=[];
 const d=new ClaudeDriver({checkAuth:async()=>true,spawnProcess:(_cmd,args)=>{argv=args;return c;}});
 const h=await d.start({prompt:'hi',engine_session_id:'real-id'},{onEvent:(...e)=>events.push(e),onId:id=>ids.push(id),onEnd:x=>ends.push(x),onWaiting:()=>{}});
 assert.equal(argv[argv.indexOf('--resume')+1],'real-id');assert.ok(argv.includes('--restricted'));assert.ok(!argv.includes('--bare'));
 c.stdout.write('{"type":"system","session_id":"returned-id"}\n');assert.deepEqual(ids,['returned-id']);
 await h.stop();c.stdout.write('{"type":"result","result":"late"}\n');assert.equal(ends.length,0);
});
test('Claude cancellation during auth prevents launching a model process',async()=>{
 let release,spawned=false;const signal=new AbortController();const auth=new Promise(r=>release=r);
 const d=new ClaudeDriver({checkAuth:()=>auth,spawnProcess:()=>{spawned=true;return child();}});
 const p=d.start({prompt:'hi'},{signal:signal.signal});signal.abort();release(true);await p;assert.equal(spawned,false);
});
test('Claude reads stdout after exit and emits result only after process close',async()=>{
 const c=child(),ends=[];const d=new ClaudeDriver({checkAuth:async()=>true,spawnProcess:()=>c});
 await d.start({prompt:'hi'},{onEvent:()=>{},onId:()=>{},onWaiting:()=>{},onEnd:x=>ends.push(x)});
 c.emit('exit',0,null);assert.equal(ends.length,0);
 c.stdout.write('{"type":"result","session_id":"official","result":"OK"}\n');assert.equal(ends.length,0);
 c.emit('close',0,null);assert.deepEqual(ends,[{status:'done',result:'OK'}]);
});
