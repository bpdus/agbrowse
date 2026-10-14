export class SelectionGuard {
 constructor(){this.version=0;this.id=null;}
 begin(id){this.id=id;return {id,version:++this.version};}
 invalidate(){this.id=null;this.version++;}
 current(){return {id:this.id,version:this.version};}
 accepts(ticket){return ticket?.id!==null && ticket?.id===this.id && ticket?.version===this.version;}
}
