import {community} from './community.mjs';
import http from 'node:http';
import {archive} from './archive.mjs';
import {customization,imageMime} from './customization.mjs';
import { migrate, transaction, deliverNews, publishRelease } from './migrations.mjs';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync, createReadStream } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=dirname(fileURLToPath(import.meta.url)), data=resolve(process.env.DATA_DIR||join(root,'data'));
mkdirSync(data,{recursive:true}); mkdirSync(join(data,'uploads'),{recursive:true});
const db=new DatabaseSync(join(data,'persona.sqlite')); db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT UNIQUE,name TEXT,password TEXT,profile TEXT DEFAULT '{}',created INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),expires INTEGER);
CREATE TABLE IF NOT EXISTS chats(id INTEGER PRIMARY KEY,title TEXT,kind TEXT,owner INTEGER REFERENCES users(id),theme TEXT DEFAULT '#a3e7c6',description TEXT DEFAULT '',invite TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS members(chat_id INTEGER REFERENCES chats(id),user_id INTEGER REFERENCES users(id),role TEXT DEFAULT 'member',nickname TEXT DEFAULT '',last_read INTEGER DEFAULT 0,PRIMARY KEY(chat_id,user_id));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,chat_id INTEGER REFERENCES chats(id),user_id INTEGER REFERENCES users(id),body TEXT,file_id TEXT,reply_to INTEGER,created INTEGER,edited INTEGER DEFAULT 0,pinned INTEGER DEFAULT 0,nonce TEXT,UNIQUE(user_id,nonce));
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,user_id INTEGER,chat_id INTEGER,name TEXT,mime TEXT,size INTEGER);
CREATE TABLE IF NOT EXISTS reactions(message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,user_id INTEGER,emoji TEXT,PRIMARY KEY(message_id,user_id,emoji));
CREATE TABLE IF NOT EXISTS blocks(user_id INTEGER,target_id INTEGER,PRIMARY KEY(user_id,target_id));
CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY,user_id INTEGER,message_id INTEGER,reason TEXT,created INTEGER);
CREATE INDEX IF NOT EXISTS msg_chat ON messages(chat_id,id);
`);
const get=(s,...p)=>db.prepare(s).get(...p), all=(s,...p)=>db.prepare(s).all(...p), run=(s,...p)=>db.prepare(s).run(...p);
migrate(db);
if(process.env.NEWS_AUTO_PUBLISH!=='0') publishRelease(db,JSON.parse(readFileSync(join(root,'release.json'),'utf8')));
const systemId=id=>!!get('SELECT 1 FROM system_accounts WHERE user_id=?',id);
const hash=x=>createHash('sha256').update(x).digest('hex'), scrypt=promisify(scryptCb);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code})};
const clean=(v,max=200)=>typeof v==='string'?v.trim().slice(0,max):'';
const user=(u,viewer=0)=>({id:u.id,username:u.username,name:u.name,profile:JSON.parse(u.profile),system:systemId(u.id),...custom.summary(viewer,u.id),checkins:viewer===u.id||social.prefs(u.id).showStats?social.stats(u.id):null});
const member=(cid,uid)=>get('SELECT * FROM members WHERE chat_id=? AND user_id=?',cid,uid)||fail(403,'Нет доступа к беседе');
const admin=(cid,uid)=>{const m=member(cid,uid);if(!['owner','admin'].includes(m.role))fail(403,'Нужны права администратора');return m};
const streams=new Map(), limits=new Map(), revisions=new Map(), instance=randomBytes(8).toString('hex');
function notifyUser(uid){revisions.set(uid,(revisions.get(uid)||0)+1);for(const r of streams.get(uid)||[])if(!r.destroyed)r.write('data: refresh\n\n')}
function event(cid){for(const m of all('SELECT user_id FROM members WHERE chat_id=?',cid))notifyUser(m.user_id)}
function limit(key,max=120){const now=Date.now(),v=limits.get(key);if(!v||now-v.at>60000){limits.set(key,{at:now,n:1});return}if(++v.n>max)fail(429,'Слишком много запросов. Подождите минуту.')}
setInterval(()=>{for(const [k,v] of limits)if(Date.now()-v.at>60000)limits.delete(k);run('DELETE FROM sessions WHERE expires<?',Date.now())},60000).unref();
const uploadSlots=new Map();
async function body(req,max=150000){
 const large=max>150000,key=req.personaUser||req.socket.remoteAddress;
 if(Number(req.headers['content-length'])>max)fail(413,'Файл или запрос слишком большой');
 if(large){if((uploadSlots.get(key)||0)>=2||[...uploadSlots.values()].reduce((a,b)=>a+b,0)>=8)fail(429,'Загрузка уже идёт, повторите чуть позже');uploadSlots.set(key,(uploadSlots.get(key)||0)+1)}
 try{let n=0,parts=[];for await(const chunk of req){n+=chunk.length;if(n>max)fail(413,'Файл или запрос слишком большой');parts.push(chunk)}return Buffer.concat(parts)}
 finally{if(large){const count=(uploadSlots.get(key)||1)-1;if(count)uploadSlots.set(key,count);else uploadSlots.delete(key)}}
}
async function json(req){try{const parsed=JSON.parse((await body(req)).toString()||'{}');if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))fail(400,'Нужен объект JSON');if(req.personaSession&&!get('SELECT 1 FROM sessions WHERE token=? AND expires>?',req.personaSession,Date.now()))fail(401,'Войдите в аккаунт');return parsed}catch(e){if(e.code)throw e;fail(400,'Некорректный запрос')}}
const vault=archive(db,notifyUser,limit),custom=customization(db,{data,body,notify:notifyUser,event,limit});
const social=community(db,{event,notify:notifyUser,body,data,limit,blocked:directBlocked,mediaCrop:custom.crop});
if(process.env.CHECKINS_EXPIRY!=='0')setInterval(()=>social.expire(),10000).unref();
function directBlocked(cid,uid){const c=get('SELECT kind FROM chats WHERE id=?',cid);return c?.kind==='direct'&&all('SELECT user_id FROM members WHERE chat_id=? AND user_id!=?',cid,uid).some(m=>{const r=custom.relation(uid,m.user_id);return r.blockedByMe||r.blockedMe})}
function messages(cid,before=Number.MAX_SAFE_INTEGER,q='',after=0,count=100){
 const rows=all(`SELECT m.*,u.name,u.username,u.profile,mb.nickname FROM messages m JOIN users u ON u.id=m.user_id LEFT JOIN members mb ON mb.chat_id=m.chat_id AND mb.user_id=m.user_id WHERE m.chat_id=? AND m.id<? AND m.id>? AND m.body LIKE ? ORDER BY m.id DESC LIMIT ?`,cid,before,after,'%'+q+'%',count).reverse();
 if(!rows.length)return [];
 const ids=rows.map(m=>m.id), marks=ids.map(()=>'?').join(',');
 const reactions=all(`SELECT message_id,emoji,user_id FROM reactions WHERE message_id IN (${marks})`,...ids);
 const fileIds=rows.map(m=>m.file_id).filter(Boolean), files=new Map(fileIds.length?all(`SELECT id,name,mime,size FROM files WHERE id IN (${fileIds.map(()=>'?').join(',')})`,...fileIds).map(f=>[f.id,f]):[]);
 return rows.map(m=>({...m,customRole:social.role(cid,m.user_id),profile:JSON.parse(m.profile),system:systemId(m.user_id),file:files.get(m.file_id)||null,reactions:reactions.filter(r=>r.message_id===m.id)}));
}
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');res.setHeader('Cache-Control','no-store');
 res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
 const send=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value))};
 try{
 const url=new URL(req.url,'http://localhost'),path=url.pathname,method=req.method;
 if(path==='/health')return send({ok:true,version:'1.3.0'});
 if(/^\/fonts\/(manrope|rubik|lora|nunito|montserrat|oswald|comfortaa|raleway)\.ttf$/.test(path)&&method==='GET'){res.setHeader('Content-Type','font/ttf');return res.end(readFileSync(join(root,'public',path.slice(1))))}
 if(!path.startsWith('/api/')){const assets={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/custom.js':'custom.js','/community.js':'community.js','/news-1.3.svg':'news-1.3.svg'};if(!assets[path])fail(404,'Не найдено');res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':path.endsWith('.svg')?'image/svg+xml':'text/html; charset=utf-8');return res.end(readFileSync(join(root,'public',assets[path])))}
 if(!['GET','HEAD'].includes(method)){const expected=process.env.APP_ORIGIN||`http://${req.headers.host}`;if(req.headers.origin&&req.headers.origin!==expected)fail(403,'Недопустимый источник запроса');if(req.headers['sec-fetch-site']==='cross-site')fail(403,'Недопустимый источник запроса')}
 
 if(path==='/api/register'||path==='/api/login'){
 if(method!=='POST')fail(405,'Недопустимый метод');limit('login:'+req.socket.remoteAddress,15);const b=await json(req),username=clean(b.username,32).toLowerCase(),password=b.password;
 if(!/^[a-z0-9_]{3,32}$/.test(username)||typeof password!=='string'||password.length<10||password.length>128)fail(400,'Логин: 3–32 латинских символа. Пароль: 10–128 символов.');
 let u=get('SELECT * FROM users WHERE username=?',username);
 if(path==='/api/register'){if(process.env.REGISTRATION_CODE&&b.code!==process.env.REGISTRATION_CODE)fail(403,'Неверный код регистрации');if(u)fail(409,'Имя пользователя уже занято');const salt=randomBytes(16).toString('hex'),pw=Buffer.from(await scrypt(password,salt,64)).toString('hex');const id=run('INSERT INTO users(username,name,password,created) VALUES(?,?,?,?)',username,clean(b.name,60)||username,salt+':'+pw,Date.now()).lastInsertRowid;u=get('SELECT * FROM users WHERE id=?',id);transaction(db,()=>deliverNews(db,Number(id),all('SELECT * FROM releases ORDER BY created DESC LIMIT 1')))}
 else{if(u&&systemId(u.id))fail(401,'Неверный логин или пароль');const [salt,pw]=(u?.password||'dummy:'+ '0'.repeat(128)).split(':');if(!timingSafeEqual(Buffer.from(await scrypt(password,salt,64)),Buffer.from(pw,'hex'))||!u)fail(401,'Неверный логин или пароль')}
 const token=randomBytes(32).toString('hex');run('INSERT INTO sessions VALUES(?,?,?)',hash(token),u.id,Date.now()+30*86400000);res.setHeader('Set-Cookie',`persona=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${process.env.COOKIE_SECURE==='1'?'; Secure':''}`);return send(user(u));}
 const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('persona='))?.slice(8)||'';
 const session=get('SELECT * FROM sessions WHERE token=? AND expires>?',hash(token),Date.now());if(!session)fail(401,'Войдите в аккаунт');const uid=session.user_id,u=get('SELECT * FROM users WHERE id=?',uid);if(!u||systemId(uid))fail(401,'Войдите в аккаунт');limit('api:'+uid,600);
 const sessionKey=hash(token);req.personaSession=sessionKey;req.personaUser=uid;const access=cid=>{const m=member(cid,uid);vault.assertChat(cid,uid,sessionKey);return m};
 const context={path,method,req,res,uid,token:sessionKey,json:()=>json(req),send,access};
 if(await vault.handle(context)||await custom.handle(context)||await social.handle(context))return;
 if(path==='/api/sync'&&method==='GET'){custom.pulse(uid,sessionKey,url.searchParams.get('idle')==='1');const peers=all('SELECT DISTINCT b.user_id id FROM members a JOIN members b ON a.chat_id=b.chat_id WHERE a.user_id=?',uid);return send({revision:instance+':'+(revisions.get(uid)||0)+':'+vault.fingerprint(uid,sessionKey),transport:process.env.REALTIME_TRANSPORT==='sse'?'sse':'poll',presence:Object.fromEntries(peers.map(p=>[p.id,custom.summary(uid,p.id)]))})}
 if(path==='/api/me'&&method==='GET')return send(user(u,uid));
 if(path==='/api/logout'&&method==='POST'){custom.forget(sessionKey);run('DELETE FROM sessions WHERE token=?',hash(token));for(const r of streams.get(uid)||[])r.end();res.setHeader('Set-Cookie','persona=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');return send({ok:true})}
 if(path==='/api/events'&&method==='GET'){if((streams.get(uid)?.size||0)>=5)fail(429,'Слишком много соединений');res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();res.write('data: connected\n\n');if(!streams.has(uid))streams.set(uid,new Set());streams.get(uid).add(res);const timer=setInterval(()=>{if(!get('SELECT token FROM sessions WHERE token=? AND expires>?',hash(token),Date.now()))return res.end();res.write('data: heartbeat\n\n')},25000);req.on('close',()=>{clearInterval(timer);streams.get(uid)?.delete(res)});return}
 if(path==='/api/profile'&&method==='PATCH'){const b=await json(req),p=custom.profile(b,JSON.parse(u.profile),uid);run('UPDATE users SET name=?,profile=? WHERE id=?',clean(b.name,60)||u.name,JSON.stringify(p),uid);for(const c of all('SELECT chat_id FROM members WHERE user_id=?',uid))event(c.chat_id);return send(user(get('SELECT * FROM users WHERE id=?',uid),uid))}
 const um=path.match(/^\/api\/users\/([a-zA-Z0-9_]{3,32})$/);
 if(um&&method==='GET'){const person=get('SELECT * FROM users WHERE username=?',um[1].toLowerCase());if(!person)fail(404,'Пользователь не найден');return send(user(person,uid))}
 if(path==='/api/users'&&method==='GET'){const q=clean(url.searchParams.get('q'),32);if(q.length<2)return send([]);return send(all('SELECT * FROM users WHERE username LIKE ? AND id!=? AND id NOT IN (SELECT user_id FROM system_accounts) LIMIT 20','%'+q+'%',uid).map(x=>user(x,uid)))}
 if(path==='/api/chats'&&method==='GET'){return send(all(`SELECT c.*,mb.role,mb.nickname,mb.last_read,(SELECT body FROM messages WHERE chat_id=c.id ORDER BY id DESC LIMIT 1) last_message,(SELECT max(created) FROM messages WHERE chat_id=c.id) updated,(SELECT count(*) FROM messages WHERE chat_id=c.id AND id>mb.last_read AND user_id!=?) unread FROM chats c JOIN members mb ON mb.chat_id=c.id WHERE mb.user_id=? ORDER BY COALESCE(updated,c.id) DESC`,uid,uid).filter(c=>vault.canChat(c.id,uid,sessionKey)).map(c=>({...c,community:social.profile(c.id),rights:social.rights(c.id,uid),folderId:vault.chatFolder(c.id,uid),appearance:JSON.parse(get('SELECT value FROM chat_preferences WHERE user_id=? AND chat_id=?',uid,c.id)?.value||'{}'),members:all('SELECT u.id,u.name,u.username,u.profile,m.role,m.nickname,m.last_read FROM members m JOIN users u ON u.id=m.user_id WHERE chat_id=?',c.id).map(m=>({...m,customRole:social.role(c.id,m.id),profile:JSON.parse(m.profile),system:systemId(m.id),...custom.summary(uid,m.id)}))})))}
 if(path==='/api/chats'&&method==='POST'){const b=await json(req),target=Number(b.userId),kind=target?'direct':'group';if(target===uid)fail(400,'Выберите другого пользователя');if(target){if(systemId(target)){const nc=get('SELECT chat_id id FROM news_chats WHERE user_id=?',uid);if(nc)return send(nc);fail(403,'Системному аккаунту нельзя написать')}if(!get('SELECT id FROM users WHERE id=?',target))fail(404,'Пользователь не найден');const existing=get("SELECT c.id FROM chats c JOIN members a ON c.id=a.chat_id JOIN members b ON c.id=b.chat_id WHERE c.kind='direct' AND a.user_id=? AND b.user_id=?",uid,target);if(existing){access(existing.id);return send(existing)}if(!social.prefs(target).directMessages)fail(403,'Пользователь ограничил новые диалоги');if(get('SELECT 1 FROM blocks WHERE (user_id=? AND target_id=?) OR (user_id=? AND target_id=?)',uid,target,target,uid))fail(403,'Общение заблокировано');}const title=clean(b.title,80);if(!target&&!title)fail(400,'Введите название беседы');const id=Number(run('INSERT INTO chats(title,kind,owner,invite) VALUES(?,?,?,?)',title,kind,uid,randomBytes(18).toString('hex')).lastInsertRowid);run('INSERT INTO members(chat_id,user_id,role) VALUES(?,?,?)',id,uid,'owner');if(target)run('INSERT INTO members(chat_id,user_id) VALUES(?,?)',id,target);event(id);return send({id})}
 if(path==='/api/join'&&method==='POST'){const b=await json(req),c=get("SELECT * FROM chats WHERE invite=? AND kind='group'",clean(b.invite,100));if(!c)fail(404,'Приглашение не найдено');if(all('SELECT user_id FROM members WHERE chat_id=?',c.id).length>=500)fail(400,'Беседа заполнена');run('INSERT OR IGNORE INTO members(chat_id,user_id) VALUES(?,?)',c.id,uid);event(c.id);return send({id:c.id})}
 const cm=path.match(/^\/api\/chats\/(\d+)(?:\/(\w+))?$/);
 if(cm){const cid=Number(cm[1]),action=cm[2],m=access(cid),c=get('SELECT * FROM chats WHERE id=?',cid);
 if(c.kind==='news'&&!(method==='GET'&&action==='messages')&&!(method==='POST'&&action==='read'))fail(403,'Это канал обновлений только для чтения');
 if(action==='members'&&method==='POST'){
  if(c.kind!=='group')fail(400,'Добавлять участников можно только в беседу');social.requireRight(cid,uid,'invite');const b=await json(req);access(cid);social.requireRight(cid,uid,'invite');
  if(!Array.isArray(b.userIds)||!b.userIds.length||b.userIds.length>50||b.userIds.some(x=>!Number.isSafeInteger(x)||x<1))fail(400,'Выберите от 1 до 50 пользователей');
  const ids=[...new Set(b.userIds)];
  transaction(db,()=>{
   let count=get('SELECT count(*) n FROM members WHERE chat_id=?',cid).n;
   for(const target of ids){
    if(!get('SELECT id FROM users WHERE id=?',target)||systemId(target))fail(404,'Пользователь не найден');
    if(get('SELECT 1 FROM members WHERE chat_id=? AND user_id=?',cid,target))continue;if(!social.prefs(target).groupInvites)fail(403,'Пользователь отключил приглашения');
    if(get('SELECT 1 FROM blocks WHERE (user_id=? AND target_id=?) OR (user_id=? AND target_id=?)',uid,target,target,uid))fail(403,'Пользователь ограничил общение');
    if(++count>500)fail(400,'Беседа заполнена');
    run('INSERT INTO members(chat_id,user_id) VALUES(?,?)',cid,target);
   }
  });event(cid);return send({ok:true});
 }
 if(!action&&method==='PATCH'){const b=await json(req);access(cid);if(c.kind!=='group')fail(403,'Изменять можно только беседу');social.requireRight(cid,uid,b.rotateInvite?'invite':'editGroup');if(['title','description','theme'].some(k=>k in b))social.requireRight(cid,uid,'editGroup');run('UPDATE chats SET title=?,description=?,theme=?,invite=? WHERE id=?',clean(b.title,80)||c.title,clean(b.description??c.description,500),/^#[\da-f]{6}$/i.test(b.theme)?b.theme:c.theme,b.rotateInvite?randomBytes(18).toString('hex'):c.invite,cid);event(cid);return send({ok:true})}
 if(action==='members'&&method==='PATCH'){const b=await json(req);access(cid);social.requireRight(cid,uid,b.remove?'kick':'manageRoles');const target=Number(b.userId),tm=member(cid,target);if(tm.role==='owner')fail(403,'Нельзя изменить владельца');if(member(cid,uid).role!=='owner'&&tm.role==='admin')fail(403,'Недостаточно прав');if(c.kind!=='group')fail(400,'Участников личного диалога нельзя изменять');if(b.remove){run('DELETE FROM members WHERE chat_id=? AND user_id=?',cid,target);notifyUser(target);}else{if(member(cid,uid).role!=='owner')fail(403,'Роли назначает владелец');run('UPDATE members SET role=? WHERE chat_id=? AND user_id=?',b.role==='admin'?'admin':'member',cid,target)}event(cid);return send({ok:true})}
 if(action==='nickname'&&method==='PATCH'){const b=await json(req);access(cid);run('UPDATE members SET nickname=? WHERE chat_id=? AND user_id=?',clean(b.nickname,60),cid,uid);event(cid);return send({ok:true})}
 if(action==='read'&&method==='POST'){const b=await json(req);access(cid);access(cid);const latest=get('SELECT COALESCE(max(id),0) id FROM messages WHERE chat_id=?',cid).id,seen=Number.isSafeInteger(b.lastId)?Math.min(b.lastId,latest):latest;const previous=m.last_read;run('UPDATE members SET last_read=MAX(last_read,?) WHERE chat_id=? AND user_id=?',seen,cid,uid);if(member(cid,uid).last_read!==previous)event(cid);return send({ok:true})}
 if(action==='messages'&&method==='GET')return send(messages(cid,Number(url.searchParams.get('before'))||Number.MAX_SAFE_INTEGER,clean(url.searchParams.get('q'),200),Math.max(0,Number(url.searchParams.get('after'))||0),Math.min(300,Math.max(1,Number(url.searchParams.get('limit'))||100))));
 if(action==='messages'&&method==='POST'){social.canWrite(cid,uid);limit('send:'+uid,60);if(directBlocked(cid,uid))fail(403,'Общение заблокировано');const b=await json(req);access(cid);social.canWrite(cid,uid);if(directBlocked(cid,uid))fail(403,'Общение заблокировано');const text=clean(b.body,4096),fid=clean(b.fileId,100)||null,reply=Number(b.replyTo)||null,nonce=clean(b.nonce,80)||randomBytes(16).toString('hex');if(!text&&!fid)fail(400,'Сообщение пустое');if(fid&&!get('SELECT id FROM files WHERE id=? AND user_id=? AND chat_id=?',fid,uid,cid))fail(403,'Нет доступа к файлу');if(reply&&!get('SELECT id FROM messages WHERE id=? AND chat_id=?',reply,cid))fail(400,'Ответ не найден');run('INSERT OR IGNORE INTO messages(chat_id,user_id,body,file_id,reply_to,created,nonce) VALUES(?,?,?,?,?,?,?)',cid,uid,text,fid,reply,Date.now(),nonce);event(cid);return send({ok:true})}
 if(action==='upload'&&method==='POST'){social.canWrite(cid,uid);if(directBlocked(cid,uid))fail(403,'Общение заблокировано');limit('upload:'+uid,20);const bytes=await body(req,25*1024*1024);if(!get('SELECT 1 FROM sessions WHERE token=? AND expires>?',sessionKey,Date.now()))fail(401,'Войдите в аккаунт');access(cid);social.canWrite(cid,uid);if(directBlocked(cid,uid))fail(403,'Общение заблокировано');if(get('SELECT COALESCE(sum(size),0) n FROM files WHERE user_id=?',uid).n+bytes.length>(Number(process.env.MAX_USER_UPLOAD_BYTES)||536870912))fail(413,'Лимит хранилища вложений исчерпан; обратитесь к владельцу сервера');const id=randomBytes(20).toString('hex'),name=clean(decodeURIComponent(req.headers['x-filename']||'file'),150),mime=clean(req.headers['content-type'],100);writeFileSync(join(data,'uploads',id),bytes);run('INSERT INTO files VALUES(?,?,?,?,?,?)',id,uid,cid,name,mime,bytes.length);return send({id,name})}
 }
 const mm=path.match(/^\/api\/messages\/(\d+)(?:\/(\w+))?$/);
 if(mm){const id=Number(mm[1]),m=get('SELECT * FROM messages WHERE id=?',id);if(!m)fail(404,'Сообщение не найдено');if(get('SELECT kind FROM chats WHERE id=?',m.chat_id).kind==='news')fail(403,'Системные новости нельзя изменять');const mb=access(m.chat_id),b=method==='DELETE'?{}:await json(req);
 access(m.chat_id);if(method!=='DELETE'&&directBlocked(m.chat_id,uid))fail(403,'Общение заблокировано');
 if(mm[2]==='reaction'&&method==='POST'){const emoji=clean(b.emoji,8);if(!['❤️','👍','🔥','😂','👀','✨'].includes(emoji))fail(400,'Неизвестная реакция');if(get('SELECT 1 FROM reactions WHERE message_id=? AND user_id=? AND emoji=?',id,uid,emoji))run('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?',id,uid,emoji);else run('INSERT INTO reactions VALUES(?,?,?)',id,uid,emoji)}
 else if(mm[2]==='pin'&&method==='POST'){social.requireRight(m.chat_id,uid,'pin');run('UPDATE messages SET pinned=? WHERE id=?',m.pinned?0:1,id)}
 else if(!mm[2]&&method==='PATCH'){social.canWrite(m.chat_id,uid);if(m.user_id!==uid)fail(403,'Можно редактировать только свои сообщения');const text=clean(b.body,4096);if(!text)fail(400,'Сообщение пустое');run('UPDATE messages SET body=?,edited=1 WHERE id=?',text,id)}
 else if(!mm[2]&&method==='DELETE'){if(m.user_id!==uid)social.requireRight(m.chat_id,uid,'deleteMessages');run('DELETE FROM messages WHERE id=?',id)}else fail(405,'Недопустимый метод');event(m.chat_id);return send({ok:true})}
 if(path.startsWith('/api/files/')&&method==='GET'){const f=get('SELECT * FROM files WHERE id=?',path.split('/').pop());if(!f)fail(404,'Файл не найден');access(f.chat_id);res.setHeader('Content-Type',/^(image\/(png|jpeg|webp|gif)|audio\/(webm|ogg|mpeg)|video\/mp4)$/.test(f.mime)?f.mime:'application/octet-stream');res.setHeader('Content-Disposition',`${/^(image\/(png|jpeg|webp|gif)|audio\/(webm|ogg|mpeg)|video\/mp4)$/.test(f.mime)&&!url.searchParams.has('download')?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);const stream=createReadStream(join(data,'uploads',f.id));stream.on('error',()=>{if(!res.headersSent)res.writeHead(404);res.end()});return stream.pipe(res)}
 if(path==='/api/block'&&method==='POST'){const b=await json(req),target=Number(b.userId);if(target===uid||systemId(target))fail(400,'Этот аккаунт нельзя заблокировать');if(!get('SELECT id FROM users WHERE id=?',target))fail(404,'Пользователь не найден');if(b.remove)run('DELETE FROM blocks WHERE user_id=? AND target_id=?',uid,target);else run('INSERT OR IGNORE INTO blocks VALUES(?,?)',uid,target);for(const c of all("SELECT id,chat_id FROM checkins WHERE state='pending' AND ((sender=? AND recipient=?) OR (sender=? AND recipient=?))",uid,target,target,uid)){run("UPDATE checkins SET state='cancelled' WHERE id=?",c.id);event(c.chat_id)}notifyUser(uid);notifyUser(target);return send({ok:true})}
 if(path==='/api/reports'&&method==='POST'){const b=await json(req),m=get('SELECT * FROM messages WHERE id=?',Number(b.messageId));if(!m)fail(404,'Сообщение не найдено');access(m.chat_id);run('INSERT INTO reports(user_id,message_id,reason,created) VALUES(?,?,?,?)',uid,m.id,clean(b.reason,1000),Date.now());return send({ok:true})}
 fail(404,'Не найдено');
 }catch(e){if(!res.headersSent)send({error:e.code&&typeof e.code==='number'?e.message:'Ошибка сервера'},typeof e.code==='number'?e.code:500);else res.end();if(!e.code)console.error(e)}
});
server.requestTimeout=30000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
server.listen(Number(process.env.PORT)||3000,process.env.HOST||'127.0.0.1',()=>console.log(`Persona: http://${process.env.HOST||'127.0.0.1'}:${process.env.PORT||3000}`));
