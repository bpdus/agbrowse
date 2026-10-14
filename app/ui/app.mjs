import {SelectionGuard} from './selection.mjs';
const $=id=>document.getElementById(id);
const state={token:'',sessions:[],active:null,stream:null,seq:0,assistant:null,health:null,selection:new SelectionGuard(),messageClosed:false};
const labels={queued:'예약',running:'실행 중',waiting_user:'사용자 확인 필요',waiting_provider:'제공자 연결 대기',paused:'중단',done:'완료',failed:'실패',uncertain:'결과 확인 필요'};
function note(text){$('notice').textContent=text;$('notice').classList.toggle('hidden',!text);}
function view(id){for(const name of ['home','conversation','settings'])$(name).classList.toggle('hidden',name!==id);document.querySelector('.address').textContent='mybrowse / '+id;}
async function api(path,body){
 const r=await fetch(path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+state.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 const x=await r.json();if(!r.ok)throw new Error(x.error?.message||x.error||`HTTP ${r.status}`);return x;
}
function element(tag,className,text){const x=document.createElement(tag);if(className)x.className=className;if(text!==undefined)x.textContent=text;return x;}
function renderLists(){
 $('chat-list').replaceChildren();$('recent-tasks').replaceChildren();$('task-count').textContent=`${state.sessions.length}개의 대화`;
 for(const s of state.sessions){
  const button=element('button','chat-entry'+(state.active?.id===s.id?' active':''));button.append(element('span','',(s.task||s.prompt)));if(s.status==='running')button.append(element('span','small-dot'));button.onclick=()=>openSession(s.id);$('chat-list').append(button);
 }
 for(const s of state.sessions.slice(0,6)){
  const card=element('button','task-card');card.append(element('span','meta',new Date(s.updated_at).toLocaleString('ko-KR')),element('strong','',s.task||s.prompt),element('span','card-bottom',`${s.engine} · ${labels[s.status]||s.status}`));card.onclick=()=>openSession(s.id);$('recent-tasks').append(card);
 }
 if(!state.sessions.length)$('recent-tasks').append(element('div','empty-card',state.token?'첫 대화를 시작하면 작업이 여기에 남습니다.':'연결 설정에서 로컬 데몬에 연결하세요.'));
}
async function refresh(){if(!state.token){renderLists();return;}const x=await api('/v1/sessions');state.sessions=x.sessions;renderLists();}
function stopStream(){state.stream?.abort();state.stream=null;}
function updateSession(s){state.active=s;$('session-title').textContent=s.prompt;$('session-meta').textContent=`${s.host} / ${s.engine} / ${s.id}`;$('session-status').textContent=labels[s.status]||s.status;for(const b of document.querySelectorAll('[data-action]')){const action=b.dataset.action;b.disabled=action==='stop'?s.status!=='running':action==='steer'?s.status!=='running'||s.engine!=='codex':s.status!=='running';}}
async function openSession(id){
 const ticket=state.selection.begin(id);stopStream();state.active=null;
 try{
  const {session}=await api('/v1/sessions/'+encodeURIComponent(id));
  if(!state.selection.accepts(ticket))return;
  updateSession(session);state.assistant=null;state.messageClosed=false;$('timeline').replaceChildren();view('conversation');renderLists();void stream(id,ticket);
 }catch(e){if(state.selection.accepts(ticket))note(e.message);}
}
function event(id,e,cursor,ticket){
 if(!state.selection.accepts(ticket)||state.active?.id!==id||e.seq<=cursor.seq)return;
 cursor.seq=e.seq;const data=e.data||{};const type=e.type.replace(/^engine\./,'');
 if(type==='turn_started'){
  state.assistant=null;state.messageClosed=false;
  if(e.type==='turn_started'&&data.prompt)$('timeline').append(element('div','bubble user',data.prompt));
 }
 if(type==='assistant_delta'){
  if(!state.assistant||state.messageClosed){state.assistant=element('div','bubble assistant','');state.messageClosed=false;$('timeline').append(state.assistant);}
  state.assistant.textContent+=data.text||'';
 }
 if(type==='assistant_message'){
  if(!data.item_id||!state.assistant){state.assistant=element('div','bubble assistant','');$('timeline').append(state.assistant);}
  state.assistant.textContent=data.text||'';state.messageClosed=true;
 }
 if(type==='turn_ended'&&data.status==='waiting_user')$('timeline').append(element('div','event-note',data.reason||'사용자 확인이 필요합니다.'));
 if(['waiting_user','engine_error','browser_not_integrated','uncertain'].includes(type))$('timeline').append(element('div','event-note',data.reason||data.message||'브라우저 연결을 기다립니다.'));
}
async function stream(id,ticket){
 const controller=new AbortController();state.stream=controller;const cursor={seq:0};
 const current=()=>!controller.signal.aborted&&state.selection.accepts(ticket)&&state.active?.id===id;
 while(current()){
  try{
   const r=await fetch(`/v1/sessions/${encodeURIComponent(id)}/events?after_seq=${cursor.seq}`,{headers:{Authorization:'Bearer '+state.token},signal:controller.signal});if(!current())return;if(!r.ok)throw new Error(`HTTP ${r.status}`);
   const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='';
   while(current()){
    const {value,done}=await reader.read();if(!current()||done)break;buffer+=decoder.decode(value,{stream:true});let i;
    while((i=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,i);buffer=buffer.slice(i+2);for(const line of block.split('\n'))if(line.startsWith('data:'))event(id,JSON.parse(line.slice(5)),cursor,ticket);}
    const {session}=await api('/v1/sessions/'+encodeURIComponent(id));if(current())updateSession(session);
   }
  }catch(e){if(e.name==='AbortError'||!current())return;note('출력 연결이 끊겼습니다. 같은 작업으로 다시 연결합니다.');}
  if(current())await new Promise(resolve=>setTimeout(resolve,1000));
 }
}
$('home-button').onclick=()=>{state.selection.invalidate();stopStream();state.active=null;view('home');void refresh().catch(e=>note(e.message));};
$('new-chat').onclick=()=>{$('home-button').click();$('prompt').focus();};
$('settings-button').onclick=()=>{state.selection.invalidate();stopStream();state.active=null;view('settings');};
$('panel-button').onclick=()=>{if(state.active)void openSession(state.active.id);else $('new-chat').click();};
$('refresh').onclick=()=>void refresh().catch(e=>note(e.message));
$('auth-form').onsubmit=async e=>{e.preventDefault();state.token=$('token').value.trim();$('token').value='';try{await refresh();note('로컬 데몬에 연결했습니다.');view('home');}catch(error){state.token='';note('연결 실패: '+error.message);}};
$('composer').onsubmit=async e=>{e.preventDefault();if(!state.token){view('settings');note('로컬 데몬 토큰을 입력하세요.');return;}const prompt=$('prompt').value.trim();if(!prompt)return;try{const {session}=await api('/v1/sessions',{prompt,host:(state.health||await api('/health')).host,engine:$('engine').value,mode:$('mode').value,client_id:'mybrowse-ui',request_id:crypto.randomUUID()});$('prompt').value='';await refresh();await openSession(session.id);}catch(error){note(error.message);}};
async function command(action){
 if(!state.active)return;
 const id=state.active.id,ticket=state.selection.current(),text=$('followup-text').value.trim();
 const {session}=await api('/v1/sessions/'+encodeURIComponent(id));if(!state.selection.accepts(ticket)||state.active?.id!==id)return;
 const response=await api(`/v1/sessions/${encodeURIComponent(id)}/commands`,{action,text,expected_revision:session.revision,request_id:crypto.randomUUID()});
 if(state.selection.accepts(ticket)&&state.active?.id===id){updateSession(response.session);$('followup-text').value='';}
 await refresh();
}
$('followup').onsubmit=e=>{e.preventDefault();void command('resume').catch(error=>note(error.message));};
for(const button of document.querySelectorAll('[data-action]'))button.onclick=()=>void command(button.dataset.action).catch(error=>note(error.message));
for(const button of document.querySelectorAll('[data-suggestion]'))button.onclick=()=>{$('prompt').value=button.dataset.suggestion;$('prompt').focus();};
for(const button of document.querySelectorAll('[data-bookmark]'))button.onclick=()=>note('Chromium 연결 후 앱 내부에서 '+button.dataset.bookmark+'을 엽니다.');
$('new-tab').onclick=()=>note('실제 탭은 독립 Chromium 앱을 연결한 뒤 사용할 수 있습니다.');
fetch('/health').then(r=>r.json()).then(x=>{state.health=x;$('host-label').textContent=x.host+' · 로컬';}).catch(()=>{$('host-label').textContent='데몬 연결 끊김';});
renderLists();
