import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {acquireInstanceLock} from '../src/instance-lock.mjs';
test('second daemon cannot open the same live data folder',()=>{
 const d=mkdtempSync(join(tmpdir(),'mybrowse-lock-')),p=join(d,'lock');
 try{const release=acquireInstanceLock(p);assert.throws(()=>acquireInstanceLock(p),/another MyBrowse daemon/);release();acquireInstanceLock(p)();}finally{rmSync(d,{recursive:true});}
});
test('malformed lock is not silently deleted',()=>{
 const d=mkdtempSync(join(tmpdir(),'mybrowse-lock-')),p=join(d,'lock');
 try{writeFileSync(p,'{}');assert.throws(()=>acquireInstanceLock(p),/stale lock/);}finally{rmSync(d,{recursive:true});}
});
