import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import {cliEnvironment} from './environment.mjs';
import {terminateChild} from './rpc.mjs';
const run=promisify(execFile);

export class ClaudeDriver {
  constructor({cwd,command='claude',spawnProcess=spawn,checkAuth,model}={}){
    Object.assign(this,{cwd,command,spawnProcess,model});
    this.checkAuth=checkAuth || (async()=>{
      const {stdout}=await run(command,['auth','status'],{env:cliEnvironment(),timeout:15000,maxBuffer:65536});
      const a=JSON.parse(stdout);return a.loggedIn && a.authMethod==='claude.ai' && a.apiProvider==='firstParty';
    });
    this.capabilities={steer:false,queue_boundary:'turn_end',browser:false};
  }
  async start(session,callbacks){
    if(callbacks.signal?.aborted)return {stop:async()=>{}};
    if(!await this.checkAuth()) {callbacks.onWaiting('claude_subscription_login_required');return {stop:async()=>{}};}
    if(callbacks.signal?.aborted)return {stop:async()=>{}};
    const args=['-p','--output-format','stream-json','--verbose','--restricted','--tools','',
      '--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
      '--settings','{"disableAllHooks":true}',
      '--system-prompt','You are MyBrowse chat. Answer in plain text. No browser tools are connected. Do not use tools or delegate.'];
    if(session.engine_session_id)args.push('--resume',session.engine_session_id);
    if(this.model)args.push('--model',this.model);
    const child=this.spawnProcess(this.command,args,{cwd:this.cwd,env:cliEnvironment(),stdio:['pipe','pipe','pipe']});
    child.stderr.resume();
    const lines=createInterface({input:child.stdout});
    let stopped=false,ended=false,hasResult=false,output='',finalResult,stopPromise;
    const stop=()=>{stopped=true;return stopPromise ||= terminateChild(child).then(()=>lines.close());};
    callbacks.signal?.addEventListener('abort',()=>{void stop();},{once:true});
    const finish=(status,result)=>{if(ended||stopped)return;ended=true;callbacks.onEnd({status,result});};
    lines.on('line',line=>{
      if(stopped||ended)return;
      let msg;try{msg=JSON.parse(line);}catch{finish('failed','invalid Claude JSON');void terminateChild(child);return;}
      if(msg.session_id)callbacks.onId(msg.session_id);
      if(msg.type==='assistant'){
        for(const c of msg.message?.content || []){
          if(c.type==='text'){output+=c.text;callbacks.onEvent('assistant_message',{text:c.text});}
          if(c.type==='tool_use'){callbacks.onWaiting('unexpected_tool_request');void terminateChild(child);stopped=true;}
        }
      }
      if(msg.type==='result'){hasResult=true;finalResult={status:msg.is_error?'failed':'done',result:msg.result || output};}
    });
    child.on('error',()=>finish('failed','claude_process_failed'));
    child.on('close',(code)=>{lines.close();if(stopped)return;if(hasResult)finish(finalResult.status,finalResult.result);else finish('failed',`Claude exited without result (${code})`);});
    child.stdin.on('error',()=>{});
    child.stdin.end(session.prompt);
    return {stop};
  }
}
