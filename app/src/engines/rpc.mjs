import {EventEmitter} from 'node:events';
import {createInterface} from 'node:readline';

export class StdioRpc extends EventEmitter {
  constructor(child,{timeout=30000}={}) {
    super(); this.child=child; this.timeout=timeout; this.next=1; this.pending=new Map(); this.closed=false;
    this.lines=createInterface({input:child.stdout});
    this.lines.on('line', line => {
      let msg; try {msg=JSON.parse(line);} catch {this.emit('protocolError',new Error('invalid JSON-RPC'));return;}
      if(msg.id !== undefined && !msg.method) {
        const p=this.pending.get(msg.id); if(!p)return;
        clearTimeout(p.timer); this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message || 'RPC error')) : p.resolve(msg.result);
      } else {this.emit(msg.id !== undefined?'request':'notification',msg);}
    });
    child.on('error', e => this.fail(e));
    child.stdin.on('error', e => this.fail(e));
    child.on('exit',(code,signal) => this.fail(new Error(`app-server exited (${code ?? signal})`)));
  }
  send(msg) {
    if(this.closed || this.child.stdin.destroyed) throw new Error('RPC closed');
    this.child.stdin.write(JSON.stringify(msg)+'\n');
  }
  request(method,params={}) {
    return new Promise((resolve,reject) => {
      const id=this.next++;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`RPC timeout: ${method}`));},this.timeout);
      this.pending.set(id,{resolve,reject,timer});
      try {this.send({id,method,params});} catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  fail(error) {
    if(this.closed)return;this.closed=true;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();
    this.lines.close();this.emit('closed',error);
  }
  close(){this.fail(new Error('RPC closed'));}
}

export async function terminateChild(child,waitMs=1500) {
  if(child.exitCode !== null || child.signalCode)return;
  await new Promise(resolve => {
    const timer=setTimeout(()=>{child.kill('SIGKILL');},waitMs);
    child.once('exit',()=>{clearTimeout(timer);resolve();});
    child.kill('SIGTERM');
  });
}
