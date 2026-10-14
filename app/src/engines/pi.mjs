import {spawn} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {cliEnvironment} from './environment.mjs';
import {PiRpc,reapChild} from './pi-rpc.mjs';

const isText = v => typeof v === 'string' && v.trim() !== '';
const noop = () => {};

function validateRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object') throw new Error('pi_runtime_invalid: runtime is required');
  for (const k of ['node','entry','agentDir','sessionDir']) {
    if (!isText(runtime[k]) || !isAbsolute(runtime[k])) throw new Error(`pi_runtime_invalid: ${k} must be an absolute path`);
  }
  for (const k of ['version','provider','model']) {
    if (!isText(runtime[k])) throw new Error(`pi_runtime_invalid: ${k} must be explicit`);
  }
  for (const k of ['provider','model']) {
    if (runtime[k].startsWith('-') || /[\u0000-\u001f\u007f]/.test(runtime[k])) throw new Error(`pi_runtime_invalid: ${k} is not a valid value`);
  }
}

// Real Pi session IDs only: no control characters or path separators.
// It is passed to --session, so it must start alphanumeric and can never look like an option or a path.
const validSessionId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(id);

function messageText(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
}

export class PiDriver {
  constructor({runtime, cwd, spawnProcess = spawn, timeout = 30000, exitGraceMs = 2000, termMs = 1500, killMs = 1500, maxRecordBytes} = {}) {
    validateRuntime(runtime);
    if (!isText(cwd) || !isAbsolute(cwd)) throw new Error('pi_runtime_invalid: cwd must be an absolute path');
    Object.assign(this, {runtime: {...runtime}, cwd, spawnProcess, timeout, exitGraceMs, termMs, killMs, maxRecordBytes});
    this.capabilities = {steer: true, queue_boundary: 'agent_settled', browser: false};
  }

  async start(session, callbacks = {}) {
    const {runtime} = this;
    const handle = {stop: async () => {}, steer: async () => { throw new Error('no active Pi run'); }};
    if (callbacks.signal?.aborted) return handle;
    const call = (name, ...args) => { try { callbacks[name]?.(...args); } catch {} };
    const resumeId = session?.engine_session_id;
    if (resumeId !== undefined && resumeId !== null && !validSessionId(resumeId)) {
      call('onEnd', {status: 'failed', result: 'pi_session_invalid: stored session ID is not usable'});
      return handle;
    }

    const args = [runtime.entry, '--mode', 'rpc', '--session-dir', runtime.sessionDir,
      '--provider', runtime.provider, '--model', runtime.model,
      '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes'];
    if (resumeId) args.push('--session', resumeId);
    let child;
    try {
      child = this.spawnProcess(runtime.node, args, {cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'],
        env: {...cliEnvironment(), PI_CODING_AGENT_DIR: runtime.agentDir}});
    } catch (e) {
      call('onEnd', {status: 'failed', result: `pi_spawn_failed: ${e.message}`});
      return handle;
    }
    child.stderr?.resume(); // diagnostics are neither logged nor forwarded
    const rpc = new PiRpc(child, {timeout: this.timeout, maxRecordBytes: this.maxRecordBytes});

    let cancelled = false, finished = false, promptSent = false, settledSeen = false;
    let lastAssistant, retryFailure, shutdownPromise, stopPromise;

    // Rejects with pi_cleanup_failed when the owned child never reaches 'close'.
    const shutdown = () => shutdownPromise ??= (async () => {
      let closed = false;
      rpc.end();
      try { closed = await reapChild(child, {graceMs: this.exitGraceMs, termMs: this.termMs, killMs: this.killMs}); } catch {}
      finally {
        rpc.close();
        callbacks.signal?.removeEventListener('abort', onAbort);
      }
      if (!closed) throw new Error('pi_cleanup_failed: Pi child did not close');
    })();
    const finish = async (status, result) => {
      if (finished || cancelled) return;
      finished = true;
      try { await shutdown(); }
      catch (e) { status = status === 'uncertain' ? status : 'failed'; result = e.message; }
      if (!cancelled) call('onEnd', {status, result});
    };
    const failure = e => promptSent && e.sent !== false && !e.responded
      ? finish('uncertain', `pi_prompt_outcome_unknown: ${e.message}`)
      : finish('failed', e.message);
    const stop = () => stopPromise ??= (async () => {
      cancelled = true;
      if (promptSent && !finished && !rpc.closed) {
        try { await rpc.request('clear_queue'); } catch {}
        try { await rpc.request('abort'); } catch {}
      }
      await shutdown();
    })();
    const onAbort = () => { stop().catch(noop); };
    callbacks.signal?.addEventListener('abort', onAbort, {once: true});

    handle.stop = stop;
    handle.steer = async text => {
      if (!isText(text)) throw new Error('steer text is required');
      if (cancelled || finished || !promptSent || settledSeen || rpc.closed) throw new Error('no active Pi run');
      await rpc.request('steer', {message: text});
    };

    rpc.on('protocolError', e => { void failure(e); });
    rpc.on('closed', e => { void failure(e); });
    rpc.on('event', ev => {
      if (finished || cancelled) return;
      if (ev.type === 'message_update') {
        const m = ev.assistantMessageEvent;
        if (m?.type === 'text_delta' && typeof m.delta === 'string') call('onEvent', 'assistant_delta', {text: m.delta});
      } else if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
        lastAssistant = ev.message; // the latest completed message is authoritative; earlier ones are not merged
        call('onEvent', 'assistant_message', {text: messageText(ev.message)});
      } else if (ev.type === 'auto_retry_end') {
        retryFailure = ev.success === false ? (ev.finalError || 'Pi retry failed') : undefined;
        if (ev.success === false) call('onEvent', 'engine_error', {message: retryFailure});
      } else if (ev.type === 'agent_settled') {
        settledSeen = true;
        const m = lastAssistant;
        if (retryFailure) void finish('failed', retryFailure);
        else if (!m) void finish('failed', 'Pi finished without an assistant message');
        else if (m.stopReason === 'error') void finish('failed', m.errorMessage || 'Pi assistant error');
        else if (m.stopReason === 'aborted') void finish('paused', messageText(m));
        else void finish('done', messageText(m));
      }
    });

    try {
      const state = await rpc.request('get_state');
      if (cancelled) { await shutdown().catch(noop); return handle; }
      const sessionId = state?.sessionId;
      if (!validSessionId(sessionId)) throw Object.assign(new Error('pi_session_invalid: Pi returned no usable session ID'), {sent: false});
      if (resumeId && sessionId !== resumeId) {
        throw Object.assign(new Error('pi_session_mismatch: Pi did not resume the stored session'), {sent: false});
      }
      const wanted = (m) => m?.provider === runtime.provider && m?.id === runtime.model;
      const models = await rpc.request('get_available_models');
      if (cancelled) { await shutdown().catch(noop); return handle; }
      if (!wanted(state.model) || !Array.isArray(models?.models) || !models.models.some(wanted)) {
        finished = true;
        // Report only after the owned child is gone; a cleanup failure is a failed end, not a wait.
        try { await shutdown(); if (!cancelled) call('onWaiting', 'pi_provider_unavailable'); }
        catch (e) { if (!cancelled) call('onEnd', {status: 'failed', result: e.message}); }
        return handle;
      }
      call('onId', sessionId);
      if (cancelled) { await shutdown().catch(noop); return handle; }
      promptSent = true;
      await rpc.request('prompt', {message: session.prompt});
    } catch (e) {
      if (cancelled) await shutdown().catch(noop); else await failure(e);
    }
    return handle;
  }
}
