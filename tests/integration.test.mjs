import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';

test('Real accounts, isolation, messages, permissions, persistence and uploads',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'persona-test-')),port=32981,base=`http://127.0.0.1:${port}`;
 let child;
 async function start(){child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),DATA_DIR:dir,REGISTRATION_CODE:''},stdio:['ignore','pipe','pipe']});await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Server exited')})])}
 async function stop(){const done=once(child,'exit');child.kill();await done}
 async function req(path,method='GET',data,cookie){const r=await fetch(base+'/api'+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]}}
 try{
 await start();
 assert.equal((await req('/chats')).status,401);
 const a=await req('/register','POST',{username:'alice',name:'Алиса',password:'StrongPassword123'}),b=await req('/register','POST',{username:'boris',name:'Борис',password:'StrongPassword123'}),x=await req('/register','POST',{username:'outsider',password:'StrongPassword123'});
 assert.equal(a.status,200);assert.equal(b.status,200);assert.ok(a.cookie);assert.ok(!('password'in a.body));
 assert.equal((await req('/login','POST',{username:'alice',password:'WrongPassword123'})).status,401);
 const dm=await req('/chats','POST',{userId:b.body.id},a.cookie),cid=dm.body.id;
 assert.equal((await req('/chats','POST',{userId:b.body.id},a.cookie)).body.id,cid);
 assert.equal((await req(`/chats/${cid}/messages`,'GET',null,x.cookie)).status,403);
 const controller=new AbortController();
 const events=await fetch(base+'/api/events',{headers:{Cookie:b.cookie},signal:controller.signal});const reader=events.body.getReader();
 assert.match(new TextDecoder().decode((await reader.read()).value),/connected/);
 assert.equal((await req(`/chats/${cid}/messages`,'POST',{body:'Привет <script>alert(1)</script>',nonce:'one'},a.cookie)).status,200);
 const pushed=await Promise.race([reader.read(),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('No live event')),2000);t.unref()})]);
 assert.match(new TextDecoder().decode(pushed.value),/refresh/);controller.abort();
 await req(`/chats/${cid}/messages`,'POST',{body:'Привет',nonce:'one'},a.cookie);
 let history=await req(`/chats/${cid}/messages`,'GET',null,b.cookie);assert.equal(history.body.length,1);const mid=history.body[0].id;
 assert.equal((await req(`/messages/${mid}`,'PATCH',{body:'Hacked'},b.cookie)).status,403);
 assert.equal((await req(`/messages/${mid}`,'PATCH',{body:'Обновлено'},a.cookie)).status,200);
 await req(`/chats/${cid}/read`,'POST',{},b.cookie);
 assert.equal((await req('/chats','GET',null,a.cookie)).body[0].members.find(m=>m.id===b.body.id).last_read,mid);
 await req(`/messages/${mid}/reaction`,'POST',{emoji:'❤️'},b.cookie);
 assert.equal((await req(`/chats/${cid}/messages`,'GET',null,b.cookie)).body[0].reactions.length,1);
 const upload=await fetch(base+`/api/chats/${cid}/upload`,{method:'POST',headers:{Cookie:a.cookie,'X-Filename':'hello.txt','Content-Type':'text/plain'},body:'hello file'});const f=await upload.json();assert.ok(f.id);
 assert.equal((await fetch(base+'/api/files/'+f.id,{headers:{Cookie:x.cookie}})).status,403);
 assert.equal(await(await fetch(base+'/api/files/'+f.id,{headers:{Cookie:b.cookie}})).text(),'hello file');
 const group=await req('/chats','POST',{title:'Наш круг'},a.cookie),gid=group.body.id;let list=await req('/chats','GET',null,a.cookie);const invite=list.body.find(c=>c.id===gid).invite;
 assert.equal((await req('/join','POST',{invite},b.cookie)).body.id,gid);
 assert.equal((await req('/chats/'+gid,'PATCH',{title:'hacked'},b.cookie)).status,403);
 await req(`/chats/${gid}/members`,'PATCH',{userId:b.body.id,role:'admin'},a.cookie);
 assert.equal((await req('/chats/'+gid,'PATCH',{title:'Друзья'},b.cookie)).status,200);
 assert.equal((await req(`/chats/${gid}/members`,'PATCH',{userId:a.body.id,remove:true},b.cookie)).status,403);
 await req('/chats/'+gid,'PATCH',{rotateInvite:true},a.cookie);
 assert.equal((await req('/join','POST',{invite},x.cookie)).status,404);
 await req('/profile','PATCH',{name:'Алиса ✨',color:'#bb99ee',bio:'Привет'},a.cookie);
 assert.equal((await req('/me','GET',null,a.cookie)).body.profile.bio,'Привет');
 const cross=await fetch(base+'/api/chats',{method:'POST',headers:{Cookie:a.cookie,Origin:'https://evil.example','Content-Type':'application/json'},body:'{"title":"bad"}'});assert.equal(cross.status,403);
 await stop();await start();assert.equal((await req(`/chats/${cid}/messages`,'GET',null,b.cookie)).body[0].body,'Обновлено');
 await req('/block','POST',{userId:a.body.id},b.cookie);assert.equal((await req(`/chats/${cid}/messages`,'POST',{body:'blocked'},a.cookie)).status,403);
 await req('/logout','POST',{},a.cookie);assert.equal((await req('/me','GET',null,a.cookie)).status,401);
 }finally{if(child?.exitCode===null)await stop();await rm(dir,{recursive:true,force:true})}
});
