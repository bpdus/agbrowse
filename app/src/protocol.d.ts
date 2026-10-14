export type Engine = 'codex' | 'claude';
export type Mode = 'chat' | 'browser';
export type Status = 'queued' | 'running' | 'waiting_user' | 'waiting_provider' | 'paused' | 'done' | 'failed' | 'uncertain';
export interface Session { id:string; host:string; client_id:string; request_id:string; task:string; prompt:string; engine:Engine; mode:Mode; status:Status; revision:number; engine_session_id:string|null; result:unknown; queue:Array<{text:string;request_id:string;created_at:string}>; created_at:string; updated_at:string; }
export interface CreateSession { host:string; client_id:string; request_id:string; prompt:string; engine:Engine; mode:Mode; }
export interface Command { action:'steer'|'queue'|'stop'|'resume'; text?:string; expected_revision:number; request_id:string; }
export interface SessionEvent { seq:number; type:string; data:Record<string,unknown>; }
export interface Capabilities { browser:boolean; opencodex:boolean; queue_boundary:'turn_end'; engines:unknown; }
/** Final Chromium WebUI implements this through browser-owned Mojo, not Node in a renderer. */
export interface MyBrowseBridge {
 create(input:CreateSession):Promise<Session>;
 command(id:string,input:Command):Promise<Session>;
 sessions():Promise<Session[]>;
 subscribe(id:string,afterSeq:number,onEvent:(event:SessionEvent)=>void):()=>void;
 capabilities():Promise<Capabilities>;
}
