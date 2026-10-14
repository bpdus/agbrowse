import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {platform,arch,totalmem} from 'node:os';
function run(cmd,args){try{return execFileSync(cmd,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}).trim();}catch{return null;}}
const mac=platform()==='darwin',developer=mac?run('xcode-select',['-p']):null;
const xcode=mac?run('xcodebuild',['-version']):null;
const sdk=mac?run('xcrun',['--sdk','macosx','--show-sdk-version']):null;
const sdkPath=mac?run('xcrun',['--sdk','macosx','--show-sdk-path']):null;
const firstLaunchReady=mac&&run('xcodebuild',['-checkFirstLaunchStatus'])!==null;
const fullXcode=!!xcode&&!!developer&&developer.endsWith('.app/Contents/Developer');
const metal=mac?run('xcrun',['--sdk','macosx','metal','--version']):null;
const metalInstalled=metal!==null;
const ready=mac&&fullXcode&&!!sdk&&!!sdkPath&&firstLaunchReady&&metalInstalled;
const result={platform:platform(),architecture:arch(),node:process.version,memoryGiB:Math.round(totalmem()/2**30),
 macOS:mac?run('sw_vers',['-productVersion']):null,developerDirectory:developer,fullXcode,xcode,
 sdk,sdkPath,firstLaunchReady,metalInstalled,metal,observed_at:new Date().toISOString(),
 disk:run('df',['-h','.']),status:ready?'PREREQUISITES_ONLY':'BLOCKED',
 next:!ready?'전체 Xcode, SDK, Metal Toolchain과 Xcode 초기 설정을 확인해야 합니다.':'고정 Chromium 커밋과 해당 버전의 빌드 조건을 확인해야 합니다.',
 source:'https://chromium.googlesource.com/chromium/src/+/main/docs/mac_build_instructions.md'};
console.log(JSON.stringify(result,null,2));if(result.status==='BLOCKED')process.exitCode=2;
