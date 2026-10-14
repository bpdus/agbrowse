import {readFileSync} from 'node:fs';
import {join} from 'node:path';

// Credentials stay in the CLI's official store; provider/proxy/JS-injection env is excluded.
export function cliEnvironment(source = process.env) {
  const keys = ['HOME','PATH','USER','LOGNAME','SHELL','TMPDIR','LANG','LC_ALL','LC_CTYPE',
    'XDG_RUNTIME_DIR','__CF_USER_TEXT_ENCODING'];
  return Object.fromEntries(keys.filter(k => source[k] !== undefined).map(k => [k,source[k]]));
}

export function codexOverrides(home = process.env.HOME) {
  let config = '';
  try { config = readFileSync(join(home,'.codex','config.toml'),'utf8'); }
  catch(e) { if(e.code !== 'ENOENT') throw e; }
  // This deliberately rejects unverified config forms instead of silently inheriting a router.
  if (/^\s*\[model_providers\.(?:openai|["']openai["'])(?:\.|\])/m.test(config) ||
      /^\s*mcp_servers\s*=/m.test(config)) {
    throw new Error('unsupported_global_config: custom OpenAI provider or inline MCP table');
  }
  const names = new Set();
  for (const match of config.matchAll(/^\s*\[mcp_servers\.(.+)\]\s*(?:#.*)?$/gm)) {
    const value=match[1];
    const key=value.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)(?:\.|$)/)?.[1];
    if(!key)throw new Error('unsupported_global_config: complex MCP name');
    names.add(key);
  }
  const values = ['model_provider="openai"','web_search="disabled"','approval_policy="on-request"',
    'sandbox_mode="read-only"','analytics.enabled=false',
    ...['shell_tool','unified_exec','apps','computer_use','plugins','hooks','multi_agent',
      'multi_agent_v2','shell_snapshot'].map(n => `features.${n}=false`),
    ...[...names].map(n => `mcp_servers.${n}.enabled=false`)];
  return values.flatMap(v => ['-c',v]);
}
