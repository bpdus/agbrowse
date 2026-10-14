// Offline checks with fake child processes. They do not replace a real Pi account,
// provider, or LLM round trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {PiRpc,reapChild,MAX_RECORD_BYTES} from '../src/engines/pi-rpc.mjs';

function child() {
  const c = new EventEmitter();
  Object.assign(c, {stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    exitCode: null, signalCode: null, killed: []});
  c.sent = [];
  c.stdin.on('data', d => c.sent.push(...String(d).split('\n').filter(Boolean).map(l => JSON.parse(l))));
  c.exit = (code = 0) => { c.exitCode = code; c.emit('exit', code, null); c.emit('close', code, null); };
  c.kill = sig => { c.killed.push(sig); };
  return c;
}
const tick = () => new Promise(r => setImmediate(r));
const reply = (c, i, extra = {}) => c.stdout.write(JSON.stringify({id: c.sent[i].id, type: 'response', command: c.sent[i].type, success: true, ...extra}) + '\n');

test('request carries a unique id and resolves with response data', async () => {
  const c = child(), r = new PiRpc(c, {timeout: 500});
  const a = r.request('get_state'), b = r.request('prompt', {message: 'hi'});
  await tick();
  assert.equal(c.sent.length, 2);
  assert.notEqual(c.sent[0].id, c.sent[1].id);
  assert.deepEqual([c.sent[1].type, c.sent[1].message], ['prompt', 'hi']);
  reply(c, 1); reply(c, 0, {data: {sessionId: 's'}});
  assert.deepEqual(await a, {sessionId: 's'});
  assert.equal(await b, undefined);
  assert.equal(r.pending.size, 0);
});

test('multi-byte UTF-8 split across chunks and several records in one chunk', async () => {
  const c = child(), r = new PiRpc(c), events = [];
  r.on('event', e => events.push(e));
  const bytes = Buffer.from('{"type":"x","t":"한글😀"}\n');
  const cut = bytes.indexOf(0xed) + 1; // inside the first Hangul character
  c.stdout.write(bytes.subarray(0, cut)); await tick();
  assert.equal(events.length, 0);
  c.stdout.write(Buffer.concat([bytes.subarray(cut), Buffer.from('{"type":"a"}\n{"type":"b"}\n{"type":"c"')])); await tick();
  assert.deepEqual(events.map(e => e.type), ['x', 'a', 'b']);
  assert.equal(events[0].t, '한글😀');
  c.stdout.write('}\n'); await tick();
  assert.equal(events.at(-1).type, 'c'); // record without LF stays buffered until LF
});

test('only LF delimits records; U+2028 inside a string does not split; blank lines are ignored', async () => {
  const c = child(), r = new PiRpc(c), events = [];
  r.on('event', e => events.push(e));
  c.stdout.write('\n{"type":"a","s":"x y"}\n\n'); await tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].s, 'x y');
});

for (const [name, line, code] of [
  ['invalid JSON', 'not json\n', 'pi_invalid_record'],
  ['non-object record', '[1]\n', 'pi_invalid_record'],
  ['record without type', '{"a":1}\n', 'pi_invalid_record'],
  ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0x7d, 0x0a]), 'pi_invalid_record'],
  ['response without id', '{"type":"response","command":"get_state","success":true}\n', 'pi_invalid_response'],
  ['response for an unknown id', '{"id":"nope","type":"response","command":"get_state","success":true}\n', 'pi_invalid_response'],
]) {
  test(`protocol error: ${name} closes the transport and fails pending requests`, async () => {
    const c = child(), r = new PiRpc(c, {timeout: 500}), errs = [];
    r.on('protocolError', e => errs.push(e));
    const p = r.request('get_state'); await tick();
    c.stdout.write(line);
    await assert.rejects(p, e => e.code === code && e.sent === true);
    assert.equal(errs[0].code, code);
    assert.equal(r.closed, true);
    await assert.rejects(r.request('get_state'), e => e.sent === false);
  });
}

test('mismatched command and duplicate responses are fatal', async () => {
  let c = child(), r = new PiRpc(c, {timeout: 500});
  let p = r.request('get_state'); await tick();
  c.stdout.write(`{"id":"${c.sent[0].id}","type":"response","command":"prompt","success":true}\n`);
  await assert.rejects(p, /does not match/);
  c = child(); r = new PiRpc(c, {timeout: 500});
  const errs = []; r.on('protocolError', e => errs.push(e));
  p = r.request('get_state');
  const q = assert.rejects(r.request('prompt', {message: 'x'}), e => e.code === 'pi_invalid_response');
  await tick();
  reply(c, 0); assert.equal(await p, undefined);
  reply(c, 0); await tick();
  assert.match(errs[0].message, /duplicate/);
  await q;
});

test('response without a boolean success is rejected', async () => {
  const c = child(), r = new PiRpc(c, {timeout: 500});
  const p = r.request('get_state'); await tick();
  c.stdout.write(`{"id":"${c.sent[0].id}","type":"response","command":"get_state"}\n`);
  await assert.rejects(p, /does not match/);
});

test('success:false rejects with responded flag and does not close the transport', async () => {
  const c = child(), r = new PiRpc(c, {timeout: 500});
  const p = r.request('prompt', {message: 'x'}); await tick();
  c.stdout.write(`{"id":"${c.sent[0].id}","type":"response","command":"prompt","success":false,"error":"busy"}\n`);
  await assert.rejects(p, e => e.code === 'pi_command_failed' && e.responded === true && /busy/.test(e.message));
  assert.equal(r.closed, false);
});

test('record size limit applies across chunks and is exactly inclusive', async () => {
  assert.equal(MAX_RECORD_BYTES, 2 * 1024 * 1024);
  let c = child(), r = new PiRpc(c, {maxRecordBytes: 40}), events = [];
  r.on('event', e => events.push(e));
  const ok = '{"type":"a","p":"' + 'x'.repeat(40 - 17 - 2) + '"}';
  assert.equal(Buffer.byteLength(ok), 40);
  c.stdout.write(ok + '\n'); await tick();
  assert.equal(events.length, 1);
  c = child(); r = new PiRpc(c, {maxRecordBytes: 40});
  const errs = []; r.on('protocolError', e => errs.push(e));
  c.stdout.write('{"type":"a","p":"' + 'x'.repeat(20)); await tick();
  c.stdout.write('x'.repeat(20)); await tick();
  assert.equal(errs[0].code, 'pi_record_too_large');
  assert.equal(r.closed, true);
});

test('timeout rejects a stalled request; pending table is emptied', async () => {
  const c = child(), r = new PiRpc(c, {timeout: 15});
  await assert.rejects(r.request('stall'), e => e.code === 'pi_rpc_timeout' && e.sent === true);
  assert.equal(r.pending.size, 0);
});

test('child exit and spawn error reject pending calls', async () => {
  let c = child(), r = new PiRpc(c, {timeout: 500});
  let p = r.request('get_state'); await tick();
  c.exit(3);
  await assert.rejects(p, /exited \(3\)/);
  c = child(); r = new PiRpc(c, {timeout: 500});
  p = r.request('get_state');
  c.emit('error', Object.assign(new Error('spawn pi ENOENT'), {code: 'ENOENT'}));
  await assert.rejects(p, e => e.code === 'pi_spawn_failed');
});

test('end() sends EOF once and later requests report sent:false', async () => {
  const c = child(), r = new PiRpc(c, {timeout: 500});
  let ended = 0; c.stdin.on('end', () => ended++);
  r.end(); r.end(); await tick();
  assert.equal(ended, 1);
  await assert.rejects(r.request('abort'), e => e.sent === false);
});

test('reapChild waits for EOF exit, then escalates SIGTERM and SIGKILL on that child only', async () => {
  let c = child();
  setTimeout(() => c.exit(0), 5);
  assert.equal(await reapChild(c, {graceMs: 200}), true);
  assert.deepEqual(c.killed, []);
  c = child();
  c.kill = sig => { c.killed.push(sig); if (sig === 'SIGKILL') queueMicrotask(() => { c.signalCode = 'SIGKILL'; c.emit('exit', null, 'SIGKILL'); c.emit('close', null, 'SIGKILL'); }); };
  assert.equal(await reapChild(c, {graceMs: 10, termMs: 10, killMs: 50}), true);
  assert.deepEqual(c.killed, ['SIGTERM', 'SIGKILL']);
});

test('exit does not stop stdout: the last frame after exit is delivered, and failure waits for close', async () => {
  const c = child(), r = new PiRpc(c, {timeout: 500}), events = [], closed = [];
  r.on('event', e => events.push(e.type)); r.on('closed', e => closed.push(e));
  const p = r.request('get_state'); await tick();
  c.exitCode = 0; c.emit('exit', 0, null);
  await tick(); await tick();
  assert.equal(r.closed, false);
  reply(c, 0, {data: 1}); c.stdout.write('{"type":"last"}\n');
  assert.equal(await p, 1);
  await tick(); assert.deepEqual(events, ['last']);
  c.emit('close', 0, null);
  assert.equal(r.closed, true); assert.equal(closed.length, 1);
});

test('reapChild does not report success between exit and a delayed close', async () => {
  const c = child(); c.exitCode = 0; c.emit('exit', 0, null);
  const r = new PiRpc(c);
  let done = false;
  const reaped = reapChild(c, {graceMs: 200}).then(v => { done = v; return v; });
  await tick(); await new Promise(res => setTimeout(res, 20));
  assert.equal(done, false);
  assert.deepEqual(c.killed, [], 'an already exited process is never signalled');
  c.emit('close', 0, null);
  assert.equal(await reaped, true); void r;
});

test('reapChild supports an already closed child and reports a child that never closes', async () => {
  const closedChild = child(); const rpc = new PiRpc(closedChild);
  closedChild.exit(0);
  assert.equal(await reapChild(closedChild, {graceMs: 5}), true); void rpc;
  const stuck = child(); new PiRpc(stuck);
  stuck.exitCode = 0; stuck.emit('exit', 0, null); // exited, 'close' never arrives
  assert.equal(await reapChild(stuck, {graceMs: 5, termMs: 5, killMs: 5}), false);
  assert.deepEqual(stuck.killed, []);
  assert.equal(stuck.stdout.destroyed, true);
});
