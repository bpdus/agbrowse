import {spawn} from 'node:child_process';
import {StdioRpc,terminateChild} from './rpc.mjs';
import {cliEnvironment,codexOverrides} from './environment.mjs';

export class CodexDriver {
 constructor({cwd,command='codex',spawnProcess=spawn,timeout=30000,model,getOverrides=codexOverrides}={}) {
  Object.assign(this,{cwd,command,spawnProcess,timeout,model,getOverrides});
  this.capabilities={steer:true,queue_boundary:'turn_end',browser:false};
 }
 async start(session,callbacks) {
  if(callbacks.signal?.aborted)return {stop:async()=>{}};
  let args;try{args=['app-server','--stdio',...this.getOverrides()];}
  catch(e){callbacks.onWaiting(e.message);return {stop:async()=>{}};}
  const child=this.spawnProcess(this.command,args,{cwd:this.cwd,env:cliEnvironment(),stdio:['pipe','pipe','pipe']});
  const rpc=new StdioRpc(child,{timeout:this.timeout});child.stderr.resume();
  let threadId,turnId,finished=false,cancelled=false,stopPromise,output='';
  const shutdown=(interrupt=false)=>{
   if(stopPromise)return stopPromise;
   stopPromise=(async()=>{
    if(interrupt && turnId && !rpc.closed){try{await rpc.request('turn/interrupt',{threadId,turnId});}catch{}}
    await terminateChild(child);rpc.close();
   })();return stopPromise;
  };
  const finish=async(status,result)=>{
   if(finished||cancelled)return;finished=true;
   await shutdown();if(!cancelled)callbacks.onEnd({status,result});
  };
  const stop=()=>{cancelled=true;return shutdown(true);};
  callbacks.signal?.addEventListener('abort',()=>{void stop();},{once:true});
  const handle={stop,steer:async text=>{
   if(finished||cancelled||!turnId)throw new Error('no active Codex turn');
   await rpc.request('turn/steer',{threadId,expectedTurnId:turnId,input:[{type:'text',text,text_elements:[]}]});
  }};
  rpc.on('closed',e=>{if(!finished&&!cancelled)void finish('failed',e.message);});
  rpc.on('request',msg=>{
   try{rpc.send({id:msg.id,error:{code:-32001,message:'MyBrowse requires user action; request not approved'}});}catch{}
   finished=true;callbacks.onWaiting(`approval_required:${msg.method}`);void stop();
  });
  rpc.on('protocolError',e=>void finish('failed',e.message));
  rpc.on('notification',({method,params:p={}})=>{
   if(finished||cancelled)return;
   if(threadId&&p.threadId&&p.threadId!==threadId)return;
   if(method==='turn/started'){turnId=p.turn?.id;callbacks.onEvent('turn_started',{turn_id:turnId});}
   if(method==='item/agentMessage/delta'){output+=p.delta||'';callbacks.onEvent('assistant_delta',{text:p.delta||''});}
   if(method==='item/completed'&&p.item?.type==='agentMessage'){
    callbacks.onEvent('assistant_message',{text:p.item.text||'',item_id:p.item.id});if(!output)output=p.item.text||'';
   }
   if(method==='error')callbacks.onEvent('engine_error',{message:p.error?.message||'Codex error'});
   if(method==='turn/completed'){
    if(turnId&&p.turn?.id!==turnId)return;
    const status=p.turn?.status;
    void finish(status==='completed'?'done':status==='interrupted'?'paused':'failed',p.turn?.error?.message||output);
   }
  });
  try{
   await rpc.request('initialize',{clientInfo:{name:'mybrowse',title:'MyBrowse',version:'0.1.0'}});rpc.send({method:'initialized'});
   const auth=await rpc.request('account/read',{refreshToken:false});
   if(auth.account?.type!=='chatgpt'){
    finished=true;callbacks.onWaiting('codex_chatgpt_login_required');await shutdown();return handle;
   }
   if(cancelled){await shutdown();return handle;}
   const params={cwd:this.cwd,sandbox:'read-only',approvalPolicy:'on-request',modelProvider:'openai',
    baseInstructions:'You are MyBrowse chat. Answer in plain text. This turn has no browser or filesystem tools. Do not execute commands or delegate.'};
   if(this.model)params.model=this.model;
   const response=await rpc.request(session.engine_session_id?'thread/resume':'thread/start',
    {...params,...(session.engine_session_id?{threadId:session.engine_session_id}:{})});
   threadId=response.thread?.id;if(!threadId)throw new Error('app-server returned no thread ID');callbacks.onId(threadId);
   if(cancelled){await shutdown();return handle;}
   const turn=await rpc.request('turn/start',{threadId,input:[{type:'text',text:session.prompt,text_elements:[]}],
    sandboxPolicy:{type:'readOnly',networkAccess:false},approvalPolicy:'on-request'});
   turnId=turn.turn?.id||turnId;
  }catch(e){if(!finished&&!cancelled)await finish('failed',e.message);else await shutdown();}
  return handle;
 }
}
