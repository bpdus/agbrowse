// Offline checks against a fake Pi process (PassThrough streams + EventEmitter).
// They do NOT replace a real Pi account, provider, or LLM round trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {getEventListeners} from 'node:events';
import {PiDriver} from '../src/engines/pi.mjs';

const runtime = {node: '/opt/node', entry: '/opt/pi/cli.js', version: '0.87.1',
  agentDir: '/data/agent', sessionDir: '/data/sessions', provider: 'prov', model: 'mod-1'};
const model = {provider: 'prov', id: 'mod-1'};
const tick = () => new Promise(r => setImmediate(r));
async function until(fn, label = 'condition') {
  for (const end = Date.now() + 3000; Date.now() < end;) { if (fn()) return; await tick(); }
  assert.fail(`timed out waiting for ${label}`);
}

// Fake Pi: records every command; `handlers[type](cmd, pi)` may return response fields,
// or `false` to stay silent (lost response). Exits on stdin EOF unless `stubborn`.
function fakePi({handlers = {}, stubborn = false} = {}) {
  const c = new EventEmitter();
  Object.assign(c, {stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    exitCode: null, signalCode: null, cmds: [], killed: [], stubborn});
  const defaults = {
    get_state: () => ({data: {sessionId: 'real-1', model, isStreaming: false}}),
    get_available_models: () => ({data: {models: [model, {provider: 'other', id: 'x'}]}}),
    prompt: () => ({}), steer: () => ({}), clear_queue: () => ({data: {steering: [], followUp: []}}), abort: () => ({}),
  };
  c.emitEvent = ev => c.stdout.write(JSON.stringify(ev) + '\n');
  c.exit = (code = 0, signal = null) => {
    if (c.exitCode !== null || c.signalCode) return;
    if (signal) c.signalCode = signal; else c.exitCode = code;
    c.emit('exit', code, signal);
    if (!c.holdClose) c.emit('close', code, signal);
  };
  c.close = () => c.emit('close', c.exitCode, c.signalCode);
  c.kill = sig => { c.killed.push(sig); if (sig === 'SIGKILL' || (sig === 'SIGTERM' && !c.hardKill)) queueMicrotask(() => c.exit(null, sig)); };
  let buf = '';
  c.stdin.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const cmd = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      c.cmds.push(cmd);
      const out = (handlers[cmd.type] ?? defaults[cmd.type] ?? (() => ({success: false, error: 'unsupported'})))(cmd, c);
      if (out === false) continue;
      c.stdout.write(JSON.stringify({id: cmd.id, type: 'response', command: cmd.type, success: true, ...out}) + '\n');
    }
  });
  c.stdin.on('end', () => { c.eof = true; if (!c.stubborn) queueMicrotask(() => c.exit(0)); });
  c.types = () => c.cmds.map(x => x.type);
  return c;
}

function harness(pi, {session = {prompt: 'hello'}, opts = {}, signal} = {}) {
  const log = {events: [], ids: [], ends: [], waits: [], spawn: undefined};
  const driver = new PiDriver({runtime, cwd: '/work', timeout: 300, exitGraceMs: 20,
    spawnProcess: (cmd, args, o) => { log.spawn = {cmd, args, o}; return pi; }, ...opts});
  const callbacks = {signal, onId: id => log.ids.push(id), onEvent: (t, d) => log.events.push([t, d]),
    onWaiting: r => log.waits.push(r), onEnd: r => log.ends.push(r)};
  return {log, driver, callbacks, start: () => driver.start(session, callbacks)};
}

const asst = (text, extra = {}) => ({role: 'assistant', content: [{type: 'text', text}], stopReason: 'stop', ...extra});
const textDelta = delta => ({type: 'message_update', assistantMessageEvent: {type: 'text_delta', contentIndex: 0, delta}});

test('constructor validates the runtime and never falls back to a default model', () => {
  assert.throws(() => new PiDriver({runtime: {...runtime, node: 'node'}, cwd: '/w'}), /node must be an absolute path/);
  assert.throws(() => new PiDriver({runtime: {...runtime, sessionDir: 'rel'}, cwd: '/w'}), /sessionDir/);
  assert.throws(() => new PiDriver({runtime: {...runtime, model: ''}, cwd: '/w'}), /model must be explicit/);
  assert.throws(() => new PiDriver({runtime: {...runtime, provider: undefined}, cwd: '/w'}), /provider/);
  assert.throws(() => new PiDriver({runtime: {...runtime, model: '--evil'}, cwd: '/w'}), /model/);
  assert.throws(() => new PiDriver({runtime, cwd: 'rel'}), /cwd/);
  assert.deepEqual(new PiDriver({runtime, cwd: '/w'}).capabilities, {steer: true, queue_boundary: 'agent_settled', browser: false});
});

test('spawn arguments and environment are pinned; secrets are not inherited', async () => {
  const saved = {...process.env};
  Object.assign(process.env, {OPENAI_API_KEY: 'fake', HTTPS_PROXY: 'evil', NODE_OPTIONS: '--evil', PI_CODING_AGENT_DIR: '/other'});
  try {
    const pi = fakePi(), h = harness(pi); await h.start(); await until(() => pi.cmds.some(c => c.type === 'prompt'));
    const {cmd, args, o} = h.log.spawn;
    assert.equal(cmd, runtime.node);
    assert.deepEqual(args.slice(0, 9), [runtime.entry, '--mode', 'rpc', '--session-dir', runtime.sessionDir, '--provider', 'prov', '--model', 'mod-1']);
    for (const f of ['--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes']) assert.ok(args.includes(f), f);
    assert.ok(!args.includes('--session'));
    assert.equal(o.cwd, '/work');
    assert.equal(o.env.PI_CODING_AGENT_DIR, runtime.agentDir);
    for (const k of ['OPENAI_API_KEY', 'HTTPS_PROXY', 'NODE_OPTIONS']) assert.equal(o.env[k], undefined, k);
    assert.ok(!JSON.stringify(args).includes('fake'));
    pi.emitEvent({type: 'agent_settled'}); h.log.ends.length || await until(() => h.log.ends.length);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('normal run: ID, deltas, final message_end result, completion only after settled and child exit', async () => {
  const pi = fakePi(), h = harness(pi, {session: {prompt: 'hi 한글'}});
  const handle = await h.start();
  await until(() => pi.cmds.some(c => c.type === 'prompt'));
  assert.deepEqual(pi.types(), ['get_state', 'get_available_models', 'prompt']);
  assert.equal(pi.cmds[2].message, 'hi 한글');
  assert.deepEqual(h.log.ids, ['real-1']);
  pi.emitEvent({type: 'agent_start'});
  pi.emitEvent({type: 'message_end', message: {role: 'user', content: 'hi'}});
  pi.emitEvent(textDelta('Hel')); pi.emitEvent(textDelta('lo'));
  pi.emitEvent({type: 'message_end', message: asst('Hello')});
  pi.emitEvent({type: 'turn_end', message: asst('Hello'), toolResults: []});
  pi.emitEvent({type: 'agent_end', messages: [], willRetry: false});
  await tick(); await tick();
  assert.equal(h.log.ends.length, 0, 'agent_end alone must not complete');
  assert.equal(pi.eof, undefined);
  pi.emitEvent({type: 'agent_settled'});
  await until(() => h.log.ends.length);
  assert.deepEqual(h.log.ends, [{status: 'done', result: 'Hello'}]);
  assert.equal(pi.eof, true);
  assert.equal(pi.exitCode, 0, 'completion is delivered after the child is gone');
  assert.deepEqual(h.log.events, [['assistant_delta', {text: 'Hel'}], ['assistant_delta', {text: 'lo'}], ['assistant_message', {text: 'Hello'}]]);
  await handle.stop(); assert.equal(h.log.ends.length, 1);
});

test('agent_end with willRetry then more events: the final message wins, nothing is concatenated', async () => {
  const pi = fakePi(), h = harness(pi); await h.start();
  await until(() => pi.cmds.some(c => c.type === 'prompt'));
  pi.emitEvent({type: 'message_end', message: {role: 'assistant', content: [{type: 'text', text: 'let me check'}, {type: 'toolCall', id: 't'}], stopReason: 'toolUse'}});
  pi.emitEvent({type: 'message_end', message: asst('', {stopReason: 'error', errorMessage: '529 overloaded'})});
  pi.emitEvent({type: 'agent_end', messages: [], willRetry: true});
  pi.emitEvent({type: 'auto_retry_start', attempt: 1}); pi.emitEvent({type: 'auto_retry_end', success: true, attempt: 2});
  await tick(); assert.equal(h.log.ends.length, 0);
  pi.emitEvent({type: 'message_end', message: asst('final answer')});
  pi.emitEvent({type: 'agent_end', messages: [], willRetry: false});
  pi.emitEvent({type: 'agent_settled'});
  await until(() => h.log.ends.length);
  assert.deepEqual(h.log.ends, [{status: 'done', result: 'final answer'}]);
});

test('settled with a final assistant error, a failed retry, or no message is failed; aborted is paused', async () => {
  const cases = [
    [[{type: 'message_end', message: asst('', {stopReason: 'error', errorMessage: 'boom'})}], {status: 'failed', result: 'boom'}],
    [[{type: 'auto_retry_end', success: false, finalError: 'gave up'}], {status: 'failed', result: 'gave up'}],
    [[], {status: 'failed', result: 'Pi finished without an assistant message'}],
    [[{type: 'message_end', message: asst('part', {stopReason: 'aborted'})}], {status: 'paused', result: 'part'}],
  ];
  for (const [evs, expected] of cases) {
    const pi = fakePi(), h = harness(pi); await h.start();
    await until(() => pi.cmds.some(c => c.type === 'prompt'));
    evs.forEach(e => pi.emitEvent(e)); pi.emitEvent({type: 'agent_settled'});
    await until(() => h.log.ends.length);
    assert.deepEqual(h.log.ends, [expected]);
  }
});

test('UTF-8 split across chunks and many records in one chunk reach the driver intact', async () => {
  const pi = fakePi(), h = harness(pi); await h.start();
  await until(() => pi.cmds.some(c => c.type === 'prompt'));
  const bytes = Buffer.from([JSON.stringify(textDelta('한글')), JSON.stringify({type: 'message_end', message: asst('한글 😀')}),
    JSON.stringify({type: 'agent_settled'})].join('\n') + '\n');
  const cut = bytes.indexOf(0xed) + 1;
  pi.stdout.write(bytes.subarray(0, cut)); await tick();
  assert.equal(h.log.events.length, 0);
  pi.stdout.write(bytes.subarray(cut));
  await until(() => h.log.ends.length);
  assert.deepEqual(h.log.ends, [{status: 'done', result: '한글 😀'}]);
  assert.deepEqual(h.log.events[0], ['assistant_delta', {text: '한글'}]);
});

test('protocol errors and oversized records: failed before prompt, uncertain after; child is cleaned up', async () => {
  // before prompt
  let pi = fakePi({handlers: {get_state: (cmd, p) => { p.stdout.write('garbage\n'); return false; }}}), h = harness(pi); await h.start();
  await until(() => h.log.ends.length);
  assert.equal(h.log.ends[0].status, 'failed'); assert.equal(pi.types().includes('prompt'), false);
  assert.ok(pi.exitCode !== null || pi.signalCode);
  // after prompt
  pi = fakePi(); h = harness(pi); await h.start();
  await until(() => pi.cmds.some(c => c.type === 'prompt'));
  pi.stdout.write('{"id":"nope","type":"response","command":"prompt","success":true}\n');
  await until(() => h.log.ends.length);
  assert.equal(h.log.ends[0].status, 'uncertain'); assert.match(h.log.ends[0].result, /pi_prompt_outcome_unknown/);
  assert.equal(pi.eof, true);
  // oversized record
  pi = fakePi(); h = harness(pi, {opts: {maxRecordBytes: 400}}); await h.start();
  await until(() => pi.cmds.some(c => c.type === 'prompt'));
  pi.stdout.write('{"type":"x","p":"' + 'y'.repeat(500) + '"}\n');
  await until(() => h.log.ends.length);
  assert.equal(h.log.ends[0].status, 'uncertain'); assert.match(h.log.ends[0].result, /exceeds 400 bytes/);
});

test('wrong command echo and duplicate responses fail the run without a second prompt', async () => {
  let pi = fakePi({handlers: {get_state: () => ({command: 'get_available_models', data: {}})}}), h = harness(pi); await h.start();
  await until(() => h.log.ends.length);
  assert.equal(h.log.ends[0].status, 'failed'); assert.deepEqual(pi.types(), ['get_state']);
  pi = fakePi({handlers: {get_state: (cmd, p) => { p.stdout.write(JSON.stringify({id: cmd.id, type: 'response', command: 'get_state', success: true, data: {sessionId: 'real-1', model}}) + '\n'); return {data: {sessionId: 'real-1', model}}; }}});
  h = harness(pi); await h.start();
  await until(() => h.log.ends.length);
  assert.equal(h.log.ends[0].status, 'failed'); assert.equal(pi.types().includes('prompt'), false);
});

test('model not ready: provider unavailable, no prompt, child cleaned up', async () => {
  const bad = [
    {get_available_models: () => ({data: {models: [{provider: 'prov', id: 'other-model'}]}})},
    {get_available_models: () => ({data: {}})},
    {get_state: () => ({data: {sessionId: 'real-1', model: {provider: 'prov', id: 'other-model'}}})},
    {get_state: () => ({data: {sessionId: 'real-1'}})},
    {get_state: () => ({data: {sessionId: 'real-1', model: {provider: 'other', id: 'mod-1'}}})},
  ];
  for (const handlers of bad) {
    const pi = fakePi({handlers}), h = harness(pi); await h.start();
    await until(() => pi.eof && pi.exitCode !== null);
    assert.deepEqual(h.log.waits, ['pi_provider_unavailable']);
    assert.equal(pi.types().includes('prompt'), false);
    assert.deepEqual(h.log.ids, []); assert.deepEqual(h.log.ends, []);
  }
});

test('failed readiness commands, timeouts and spawn errors are reported as failed', async () => {
  let pi = fakePi({handlers: {get_state: () => ({success: false, error: 'nope'})}}), h = harness(pi); await h.start();
  await until(() => h.log.ends.length); assert.equal(h.log.ends[0].status, 'failed'); assert.match(h.log.ends[0].result, /nope/);
  pi = fakePi({handlers: {get_state: () => false}}); h = harness(pi, {opts: {timeout: 20}}); await h.start();
  await until(() => h.log.ends.length); assert.equal(h.log.ends[0].status, 'failed'); assert.match(h.log.ends[0].result, /timeout/);
  assert.equal(pi.types().includes('prompt'), false);
  const throwing = new PiDriver({runtime, cwd: '/w', spawnProcess: () => { throw new Error('EACCES'); }});
  const ends = []; await throwing.start({prompt: 'x'}, {onEnd: r => ends.push(r)});
  assert.equal(ends[0].status, 'failed'); assert.match(ends[0].result, /pi_spawn_failed: EACCES/);
  pi = fakePi(); h = harness(pi); await h.start();
  pi.emit('error', Object.assign(new Error('spawn ENOENT'), {code: 'ENOENT'}));
  await until(() => h.log.ends.length || pi.eof);
  assert.ok(pi.exitCode !== null || pi.signalCode);
});

test('actual session ID is reported; a resume ID is passed through and verified', async () => {
  let pi = fakePi({handlers: {get_state: () => ({data: {sessionId: 'saved-9', model}})}});
  let h = harness(pi, {session: {prompt: 'again', engine_session_id: 'saved-9'}}); await h.start();
  await until(() => pi.cmds.some(c => c.type === 'prompt'));
  const {args} = h.log.spawn;
  assert.equal(args[args.indexOf('--session') + 1], 'saved-9');
  assert.deepEqual(h.log.ids, ['saved-9']);
  // Pi came back with a different session: no new session, no prompt, no onId
  pi = fakePi(); h = harness(pi, {session: {prompt: 'again', engine_session_id: 'saved-9'}}); await h.start();
  await until(() => h.log.ends.length);
  assert.equal(h.log.ends[0].status, 'failed'); assert.match(h.log.ends[0].result, /pi_session_mismatch/);
  assert.deepEqual(pi.types(), ['get_state']); assert.deepEqual(h.log.ids, []);
  assert.equal(pi.cmds.some(c => c.type === 'new_session'), false);
  // unusable IDs, stored or returned
  for (const id of ['../x', 'a/b', 'a\nb']) {
    let spawned = false; const ends = [];
    await new PiDriver({runtime, cwd: '/w', spawnProcess: () => { spawned = true; }}).start({prompt: 'x', engine_session_id: id}, {onEnd: r => ends.push(r)});
    assert.equal(spawned, false); assert.equal(ends[0].status, 'failed');
  }
  for (const sid of ['a/b', '', undefined, 'x\u0000y']) {
    pi = fakePi({handlers: {get_state: () => ({data: {sessionId: sid, model}})}}); h = harness(pi); await h.start();
    await until(() => h.log.ends.length);
    assert.equal(h.log.ends[0].status, 'failed'); assert.deepEqual(h.log.ids, []);
  }
});

test('stop during startup: no ID, no model request, child reaped, no completion callback', async () => {
  const ac = new AbortController();
  const pi = fakePi({handlers: {get_state: () => false}}), h = harness(pi, {signal: ac.signal});
  const started = h.start();
  await until(() => pi.cmds.length === 1);
  ac.abort();
  await started;
  await until(() => pi.exitCode !== null || pi.signalCode);
  assert.equal(pi.eof, true);
  assert.deepEqual(pi.types(), ['get_state']); assert.deepEqual(h.log.ids, []); assert.deepEqual(h.log.ends, []);
  // pre-aborted signal never spawns
  let spawned = false; const pre = new AbortController(); pre.abort();
  await new PiDriver({runtime, cwd: '/w', spawnProcess: () => { spawned = true; }}).start({prompt: 'x'}, {signal: pre.signal});
  assert.equal(spawned, false);
});

test('stop while the readiness reply is late still prevents the prompt', async () => {
  let release; const pi = fakePi({handlers: {get_state: (cmd, p) => { release = () => p.stdout.write(JSON.stringify({id: cmd.id, type: 'response', command: 'get_state', success: true, data: {sessionId: 'real-1', model}}) + '\n'); return false; }}});
  const h = harness(pi), ac = new AbortController(); h.callbacks.signal = ac.signal;
  const started = h.driver.start({prompt: 'x'}, h.callbacks);
  await until(() => pi.cmds.length === 1);
  ac.abort(); release();
  await started;
  assert.equal(pi.types().includes('prompt'), false); assert.deepEqual(h.log.ids, []);
  assert.ok(pi.exitCode !== null || pi.signalCode);
});

test('steer goes to the running task only and stays rejected after stop', async () => {
  const pi = fakePi(), h = harness(pi);
  const handle = await h.start();
  await until(() => pi.cmds.some(c => c.type === 'prompt'));
  await handle.steer('change course');
  assert.deepEqual(pi.cmds.at(-1), {type: 'steer', message: 'change course', id: pi.cmds.at(-1).id});
  await assert.rejects(handle.steer('  '), /required/);
  pi.emitEvent({type: 'message_end', message: asst('ok')}); pi.emitEvent({type: 'agent_settled'});
  await until(() => h.log.ends.length);
  await assert.rejects(handle.steer('late'), /no active Pi run/);
  // not running yet
  const idle = await new PiDriver({runtime, cwd: '/w', spawnProcess: () => fakePi()}).start({prompt: 'x'}, {signal: (() => { const a = new AbortController(); a.abort(); return a.signal; })()});
  await assert.rejects(idle.steer('x'), /no active Pi run/);
});

test('stop: clear_queue first, abort exactly once, then EOF and child exit; steer blocked; idempotent', async () => {
  const order = [];
  const pi = fakePi({handlers: {
    clear_queue: () => { order.push('clear_queue'); return {data: {steering: ['queued'], followUp: []}}; },
    abort: (cmd, p) => { order.push(`abort(eof=${!!p.eof})`); return {}; },
  }});
  const h = harness(pi); const handle = await h.start();
  await until(() => pi.cmds.some(c => c.type === 'prompt'));
  pi.emitEvent(textDelta('partial'));
  const s1 = handle.stop(), s2 = handle.stop();
  assert.equal(s1, s2);
  await assert.rejects(handle.steer('new instruction during stop'), /no active Pi run/);
  await s1; await handle.stop();
  assert.deepEqual(order, ['clear_queue', 'abort(eof=false)']);
  assert.deepEqual(pi.types().slice(-3), ['prompt', 'clear_queue', 'abort']);
  assert.equal(pi.types().filter(t => t === 'steer').length, 0);
  assert.equal(pi.eof, true); assert.equal(pi.exitCode, 0);
  pi.emitEvent({type: 'message_end', message: asst('late')}); pi.emitEvent({type: 'agent_settled'}); await tick();
  assert.deepEqual(h.log.ends, []);
  assert.equal(h.log.events.length, 1, 'late events are ignored after stop');
});

test('stop escalates to SIGTERM then SIGKILL only for a child that ignores EOF', async () => {
  const pi = fakePi({stubborn: true}); pi.hardKill = true;
  const h = harness(pi); const handle = await h.start();
  await until(() => pi.cmds.some(c => c.type === 'prompt'));
  const stopping = handle.stop();
  await stopping;
  assert.deepEqual(pi.killed, ['SIGTERM', 'SIGKILL']);
  assert.equal(pi.signalCode, 'SIGKILL');
});

test('stop with an unresponsive Pi still finishes (command timeouts are bounded) and kills the child', async () => {
  const pi = fakePi({handlers: {clear_queue: () => false, abort: () => false}});
  const h = harness(pi, {opts: {timeout: 20}}); const handle = await h.start();
  await until(() => pi.cmds.some(c => c.type === 'prompt'));
  await handle.stop();
  assert.deepEqual(pi.types().slice(-2), ['clear_queue', 'abort']);
  assert.ok(pi.exitCode !== null || pi.signalCode);
});

test('prompt sent but response lost: uncertain, never re-sent', async () => {
  const pi = fakePi({handlers: {prompt: () => false}});
  const h = harness(pi, {opts: {timeout: 25}}); await h.start();
  await until(() => h.log.ends.length);
  assert.equal(h.log.ends[0].status, 'uncertain');
  assert.equal(pi.types().filter(t => t === 'prompt').length, 1);
  assert.ok(pi.exitCode !== null || pi.signalCode);
  // child dies right after the prompt is written
  const pi2 = fakePi({handlers: {prompt: (cmd, p) => { queueMicrotask(() => p.exit(1)); return false; }}});
  const h2 = harness(pi2); await h2.start();
  await until(() => h2.log.ends.length);
  assert.equal(h2.log.ends[0].status, 'uncertain'); assert.equal(pi2.types().filter(t => t === 'prompt').length, 1);
  // process exits after an accepted prompt but before settled
  const pi3 = fakePi(); const h3 = harness(pi3); await h3.start();
  await until(() => pi3.cmds.some(c => c.type === 'prompt'));
  await tick(); pi3.exit(1);
  await until(() => h3.log.ends.length);
  assert.equal(h3.log.ends[0].status, 'uncertain');
});

test('a lost prompt response does not matter when agent_settled still arrives', async () => {
  const pi = fakePi({handlers: {prompt: (cmd, p) => {
    queueMicrotask(() => { p.emitEvent({type: 'message_end', message: asst('fine')}); p.emitEvent({type: 'agent_settled'}); });
    return false;
  }}});
  const h = harness(pi); await h.start();
  await until(() => h.log.ends.length);
  assert.deepEqual(h.log.ends, [{status: 'done', result: 'fine'}]);
});

test('prompt rejected before acceptance (success:false) is a definite failure', async () => {
  const pi = fakePi({handlers: {prompt: () => ({success: false, error: 'busy'})}});
  const h = harness(pi); await h.start();
  await until(() => h.log.ends.length);
  assert.equal(h.log.ends[0].status, 'failed'); assert.match(h.log.ends[0].result, /busy/);
});

test('callback exceptions never block cleanup or later completion', async () => {
  const pi = fakePi(), log = [];
  const driver = new PiDriver({runtime, cwd: '/w', timeout: 300, exitGraceMs: 20, spawnProcess: () => pi});
  const boom = () => { throw new Error('callback exploded'); };
  await driver.start({prompt: 'x'}, {onId: boom, onEvent: boom, onWaiting: boom, onEnd: r => { log.push(r); throw new Error('end exploded'); }});
  await until(() => pi.cmds.some(c => c.type === 'prompt'));
  pi.emitEvent(textDelta('a')); pi.emitEvent({type: 'message_end', message: asst('done!')}); pi.emitEvent({type: 'agent_settled'});
  await until(() => log.length);
  assert.deepEqual(log, [{status: 'done', result: 'done!'}]);
  assert.equal(pi.eof, true); assert.equal(pi.exitCode, 0);
  // onEnd throwing on a failure path, and a throwing onId before a stop
  const pi2 = fakePi({handlers: {get_state: () => ({success: false, error: 'x'})}}), l2 = [];
  await new PiDriver({runtime, cwd: '/w', spawnProcess: () => pi2}).start({prompt: 'x'}, {onEnd: r => { l2.push(r); throw new Error('end exploded'); }});
  await until(() => l2.length); assert.ok(pi2.exitCode !== null || pi2.signalCode);
  const pi3 = fakePi(), h3 = harness(pi3);
  h3.callbacks.onId = boom;
  const handle = await h3.driver.start({prompt: 'x'}, h3.callbacks);
  await until(() => pi3.cmds.some(c => c.type === 'prompt'));
  await handle.stop(); assert.equal(pi3.exitCode, 0);
});

test('a missing callback object or hooks do not crash the driver', async () => {
  const pi = fakePi(), driver = new PiDriver({runtime, cwd: '/w', spawnProcess: () => pi, exitGraceMs: 20});
  const handle = await driver.start({prompt: 'x'});
  await until(() => pi.cmds.some(c => c.type === 'prompt'));
  pi.emitEvent(textDelta('z')); pi.emitEvent({type: 'agent_settled'});
  await handle.stop();
  assert.ok(pi.exitCode !== null || pi.signalCode);
});

test('exit then delayed close: the final stdout frame counts and onEnd waits for close', async () => {
  const pi = fakePi({stubborn: true}); pi.holdClose = true;
  const h = harness(pi, {opts: {exitGraceMs: 200}}); await h.start();
  await until(() => pi.cmds.some(c => c.type === 'prompt'));
  pi.emitEvent({type: 'message_end', message: asst('last words')});
  pi.exit(0); // process gone, stdio not yet closed
  pi.emitEvent({type: 'agent_settled'}); // final frame still arrives after exit
  await until(() => h.log.events.some(e => e[0] === 'assistant_message'));
  await new Promise(r => setTimeout(r, 40));
  assert.deepEqual(h.log.ends, [], 'no completion before close');
  pi.close();
  await until(() => h.log.ends.length);
  assert.deepEqual(h.log.ends, [{status: 'done', result: 'last words'}]);
});

test('a child that never closes: completion fails, stop rejects, nothing is left unhandled', async () => {
  const pi = fakePi(); pi.holdClose = true;
  const h = harness(pi, {opts: {exitGraceMs: 10, termMs: 10, killMs: 10}}); const handle = await h.start();
  await until(() => pi.cmds.some(c => c.type === 'prompt'));
  pi.emitEvent({type: 'message_end', message: asst('ok')}); pi.emitEvent({type: 'agent_settled'});
  await until(() => h.log.ends.length, 'onEnd', );
  assert.equal(h.log.ends[0].status, 'failed'); assert.match(h.log.ends[0].result, /pi_cleanup_failed/);
  await assert.rejects(handle.stop(), /pi_cleanup_failed/);
  // stop path
  const pi2 = fakePi(); pi2.holdClose = true;
  const h2 = harness(pi2, {opts: {exitGraceMs: 10, termMs: 10, killMs: 10}}); const handle2 = await h2.start();
  await until(() => pi2.cmds.some(c => c.type === 'prompt'));
  await assert.rejects(handle2.stop(), /pi_cleanup_failed/);
  assert.deepEqual(h2.log.ends, []);
  // AbortSignal path must not produce an unhandled rejection
  const unhandled = []; const on = e => unhandled.push(e); process.on('unhandledRejection', on);
  const pi3 = fakePi(); pi3.holdClose = true; const ac = new AbortController();
  const h3 = harness(pi3, {opts: {exitGraceMs: 10, termMs: 10, killMs: 10}, signal: ac.signal}); await h3.start();
  await until(() => pi3.cmds.some(c => c.type === 'prompt'));
  ac.abort();
  await until(() => pi3.eof && (pi3.exitCode !== null || pi3.signalCode));
  await new Promise(r => setTimeout(r, 60));
  process.off('unhandledRejection', on);
  assert.deepEqual(unhandled, []);
});

test('the abort listener is removed after the run ends, after stop, and after a failed start', async () => {
  const ac = new AbortController();
  let pi = fakePi(), h = harness(pi, {signal: ac.signal}); await h.start();
  assert.equal(getEventListeners(ac.signal, 'abort').length, 1);
  await until(() => pi.cmds.some(c => c.type === 'prompt'));
  pi.emitEvent({type: 'message_end', message: asst('x')}); pi.emitEvent({type: 'agent_settled'});
  await until(() => h.log.ends.length);
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
  pi = fakePi(); h = harness(pi, {signal: ac.signal}); const handle = await h.start();
  await until(() => pi.cmds.some(c => c.type === 'prompt'));
  await handle.stop();
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
  pi = fakePi({handlers: {get_available_models: () => ({data: {models: []}})}}); h = harness(pi, {signal: ac.signal}); await h.start();
  await until(() => pi.exitCode !== null);
  await tick();
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
});

test('session IDs must look like real IDs: UUIDs pass, option-like or path-like values do not reach --session', async () => {
  const uuid = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  const pi = fakePi({handlers: {get_state: () => ({data: {sessionId: uuid, model}})}});
  const h = harness(pi, {session: {prompt: 'x', engine_session_id: uuid}}); await h.start();
  await until(() => pi.cmds.some(c => c.type === 'prompt'));
  assert.deepEqual(h.log.ids, [uuid]);
  for (const id of ['--help', '-x', '_a', 'a b', 'a.b', 'a:b', '']) {
    let spawned = false; const ends = [];
    await new PiDriver({runtime, cwd: '/w', spawnProcess: () => { spawned = true; }}).start({prompt: 'x', engine_session_id: id || ' '}, {onEnd: r => ends.push(r)});
    assert.equal(spawned, false, id); assert.equal(ends[0].status, 'failed');
  }
  const bad = fakePi({handlers: {get_state: () => ({data: {sessionId: '--evil', model}})}}), hb = harness(bad); await hb.start();
  await until(() => hb.log.ends.length);
  assert.equal(hb.log.ends[0].status, 'failed'); assert.deepEqual(hb.log.ids, []);
});

test('a failed retry after an earlier good assistant message is never reported as done', async () => {
  const pi = fakePi(), h = harness(pi); await h.start();
  await until(() => pi.cmds.some(c => c.type === 'prompt'));
  pi.emitEvent({type: 'message_end', message: asst('earlier good answer')});
  pi.emitEvent({type: 'auto_retry_end', success: false, finalError: 'retries exhausted'});
  pi.emitEvent({type: 'agent_settled'});
  await until(() => h.log.ends.length);
  assert.deepEqual(h.log.ends, [{status: 'failed', result: 'retries exhausted'}]);
});

test('provider unavailable: waiting only after a clean close; cleanup failure is a failed end without waiting', async () => {
  const handlers = {get_available_models: () => ({data: {models: []}})};
  let pi = fakePi({handlers}), h = harness(pi); await h.start();
  assert.deepEqual(h.log.waits, ['pi_provider_unavailable']); assert.deepEqual(h.log.ends, []);
  assert.ok(pi.exitCode !== null || pi.signalCode);
  pi = fakePi({handlers}); pi.holdClose = true;
  h = harness(pi, {opts: {exitGraceMs: 10, termMs: 10, killMs: 10}}); const handle = await h.start();
  assert.deepEqual(h.log.waits, []);
  assert.equal(h.log.ends.length, 1);
  assert.equal(h.log.ends[0].status, 'failed'); assert.match(h.log.ends[0].result, /^pi_cleanup_failed/);
  assert.equal(pi.types().includes('prompt'), false);
  await assert.rejects(handle.stop(), /pi_cleanup_failed/);
  assert.equal(h.log.ends.length, 1);
});
