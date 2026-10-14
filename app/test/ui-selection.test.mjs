import test from 'node:test';import assert from 'node:assert/strict';import {SelectionGuard} from '../ui/selection.mjs';
test('late A open response and stream cannot overwrite selected B',()=>{
 const g=new SelectionGuard(),a=g.begin('A'),b=g.begin('B');let display;
 for(const ticket of [b,a])if(g.accepts(ticket))display=ticket.id;
 assert.equal(display,'B');assert.equal(g.accepts(a),false);assert.equal(g.accepts(b),true);
});
test('leaving a conversation invalidates its command response and stream',()=>{
 const g=new SelectionGuard(),a=g.begin('A');g.invalidate();assert.equal(g.accepts(a),false);
 const reopened=g.begin('A');assert.equal(g.accepts(a),false);assert.equal(g.accepts(reopened),true);
});
test('each SSE connection retains an independent sequence cursor',()=>{
 const g=new SelectionGuard(),a=g.begin('A'),cursorA={seq:90};const b=g.begin('B'),cursorB={seq:0};
 const apply=(ticket,cursor,seq)=>{if(g.accepts(ticket)&&seq>cursor.seq)cursor.seq=seq;};
 apply(a,cursorA,100);apply(b,cursorB,1);assert.equal(cursorA.seq,90);assert.equal(cursorB.seq,1);
});
