import {readdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
import {execFileSync} from 'node:child_process';
const roots=['src','ui','scripts','test','browser'];let count=0;
function check(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())check(p);else if(e.name.endsWith('.mjs')){execFileSync(process.execPath,['--check',p]);count++;}}}
for(const dir of roots)check(join(root,dir));console.log(`${count} JavaScript files checked`);
