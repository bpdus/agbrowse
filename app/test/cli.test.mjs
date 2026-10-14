import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
test('missing daemon and token are concise errors without a stack trace',()=>{
 for(const args of [['session','list'],['auth','token']]){
  const x=spawnSync(process.execPath,[cli,...args],{env:{PATH:process.env.PATH,MYBROWSE_DATA_DIR:'/nonexistent/mybrowse-test'},encoding:'utf8'});
  assert.equal(x.status,1);assert.ok(!x.stderr.includes(' at '));assert.ok(x.stderr.trim());
 }
});
