import {randomBytes} from 'node:crypto';
import {writeFileSync,createReadStream,unlinkSync} from 'node:fs';
import {join} from 'node:path';
const fail=(code,message)=>{throw Object.assign(new Error(message),{code})};
const text=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
const hex=v=>/^#[a-f0-9]{6}$/i.test(v||'');
export function imageMime(bytes){
 if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return 'image/png';
 if(bytes.length>=10&&['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString()))return 'image/gif';
 if(bytes.length>=12&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';
 if(bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
 return null;
}
export function customization(db,{data,body,notify,event,limit}){
 const get=(s,...p)=>db.prepare(s).get(...p),all=(s,...p)=>db.prepare(s).all(...p),run=(s,...p)=>db.prepare(s).run(...p);
 const heartbeats=new Map();
 function pulse(uid,token,idle=false){heartbeats.set(token,{uid,at:Date.now(),idle})}
 function presence(uid){
  const pref=JSON.parse(get('SELECT value FROM preferences WHERE user_id=?',uid)?.value||'{}'),mode=pref.presence||'online';
  if(mode==='offline')return 'offline';
  const beats=[...heartbeats.values()].filter(x=>x.uid===uid&&Date.now()-x.at<45000);
  if(!beats.length)return 'offline';
  if(mode==='dnd'||mode==='away')return mode;
  return beats.some(x=>!x.idle)?'online':'away';
 }
 function forget(token){heartbeats.delete(token)}
 setInterval(()=>{for(const [key,h] of heartbeats)if(Date.now()-h.at>60000)heartbeats.delete(key)},30000).unref();
 function relation(uid,target){return {blockedByMe:!!get('SELECT 1 FROM blocks WHERE user_id=? AND target_id=?',uid,target),blockedMe:!!get('SELECT 1 FROM blocks WHERE user_id=? AND target_id=?',target,uid)}}
 function summary(uid,target){const rel=relation(uid,target),privacy=JSON.parse(get('SELECT value FROM privacy WHERE user_id=?',target)?.value||'{}');return {...rel,presence:rel.blockedByMe||rel.blockedMe||(uid!==target&&privacy.showPresence===false)?'offline':presence(target)}}
 function media(id,uid,kind){const m=get('SELECT * FROM profile_media WHERE id=? AND user_id=?',id,uid);if(!m||(kind&&m.kind!==kind))fail(400,'Изображение не принадлежит этому профилю');return m}
 function crop(value,uid,kind){if(value===null)return null;if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'Некорректное изображение');const m=media(value.id,uid,kind);const number=(v,def,min,max)=>Number.isFinite(v)?Math.min(max,Math.max(min,v)):def;return {id:m.id,mime:m.mime,x:number(value.x,50,0,100),y:number(value.y,50,0,100),zoom:number(value.zoom,1,1,3)}}
 function settings(b,previous,uid){
  const result={...previous};
  const enums={theme:['dark','light','auto'],density:['compact','cozy'],font:['system','serif','mono','manrope','rubik','lora','nunito','montserrat','oswald','comfortaa','raleway'],sidebarSide:['left','right'],sendSide:['left','right'],toolbarPosition:['bottom','top'],wallpaper:['none','dots','lines','gradient'],presence:['online','dnd','away','offline']};
  for(const [k,values] of Object.entries(enums))if(k in b){if(!values.includes(b[k]))fail(400,'Некорректная настройка '+k);result[k]=b[k]}
  for(const [k,min,max] of [['fontSize',12,20],['bubbleRadius',4,28],['messageWidth',55,95]])if(k in b){if(!Number.isFinite(b[k])||b[k]<min||b[k]>max)fail(400,'Некорректная настройка '+k);result[k]=b[k]}
  for(const k of ['accent','backgroundColor','bubbleColor'])if(k in b){if(!hex(b[k]))fail(400,'Нужен цвет #RRGGBB');result[k]=b[k]}
  for(const k of ['animations','showAvatars','showContext','enterSends','enabled'])if(k in b){if(typeof b[k]!=='boolean')fail(400,'Нужен переключатель');result[k]=b[k]}
  if('wallpaperMedia' in b)result.wallpaperMedia=crop(b.wallpaperMedia,uid,'background');
  if('toolbarOrder' in b){if(!Array.isArray(b.toolbarOrder)||![2,3].includes(b.toolbarOrder.length)||new Set(b.toolbarOrder).size!==b.toolbarOrder.length||!b.toolbarOrder.includes('attach')||!b.toolbarOrder.includes('send')||b.toolbarOrder.some(x=>!['attach','voice','send'].includes(x)))fail(400,'Некорректный порядок кнопок');result.toolbarOrder=b.toolbarOrder.filter(x=>x!=='voice')}
  return result;
 }
 function profile(b,old,uid){
  const p=b.reset===true?{}:{...old};if(b.reset===true)return p;for(const [k,n] of [['bio',1000],['status',100],['emoji',8],['pronouns',40],['location',80]])if(k in b)p[k]=text(b[k],n);
  for(const k of ['color','profileColor'])if(k in b){if(!hex(b[k]))fail(400,'Некорректный цвет');p[k]=b[k]}
  if('avatarShape'in b){if(!['circle','rounded','square'].includes(b.avatarShape))fail(400,'Некорректная форма аватара');p.avatarShape=b.avatarShape}
  if('banner'in b){if(!['mint','violet','sunset'].includes(b.banner))fail(400,'Некорректный баннер');p.banner=b.banner}
  if('avatarMedia'in b)p.avatarMedia=crop(b.avatarMedia,uid,'avatar');
  if('bannerMedia'in b)p.bannerMedia=crop(b.bannerMedia,uid,'banner');
  if('avatar'in b){if(b.avatar&&!/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(b.avatar))fail(400,'Недопустимый аватар');if(typeof b.avatar!=='string'||b.avatar.length>100000)fail(400,'Аватар слишком большой');p.avatar=b.avatar}
  if('links'in b){if(!Array.isArray(b.links)||b.links.length>8)fail(400,'Можно добавить до 8 ссылок');p.links=b.links.map(link=>{if(!link||typeof link.url!=='string'||link.url.length>500)fail(400,'Некорректная ссылка');let url;try{url=new URL(link.url)}catch{fail(400,'Ссылка должна начинаться с https:// или http://')}if(!['https:','http:'].includes(url.protocol)||url.username||url.password)fail(400,'Разрешены только обычные веб-ссылки');return {label:text(link.label,40)||url.hostname,url:url.href}})}
  if('socials'in b){if(!b.socials||typeof b.socials!=='object'||Array.isArray(b.socials))fail(400,'Некорректные социальные сети');p.socials={};for(const [k,v] of Object.entries(b.socials)){if(!['discord','telegram','instagram','vk','tiktok'].includes(k)||typeof v!=='string')fail(400,'Неизвестная социальная сеть');const handle=v.trim().replace(/^@/,'');if(!handle)continue;const pattern=k==='telegram'?/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/:k==='discord'?/^[a-zA-Z0-9_.]{2,32}$/:/^[a-zA-Z0-9_.]{1,64}$/;if(!pattern.test(handle))fail(400,'Укажите корректное имя пользователя: '+k);p.socials[k]=['telegram','instagram','tiktok'].includes(k)?'@'+handle:handle}delete p.links;}
  return p;
 }
 async function handle(ctx){
  const {path,method,req,res,uid,json,send,access}=ctx;
  if(path==='/api/preferences'&&method==='GET'){send(JSON.parse(get('SELECT value FROM preferences WHERE user_id=?',uid)?.value||'{}'));return true}
  if(path==='/api/preferences'&&method==='PATCH'){const b=await json(),old=JSON.parse(get('SELECT value FROM preferences WHERE user_id=?',uid)?.value||'{}'),p=b.reset===true?{presence:old.presence||'online'}:settings(b,old,uid);if(b.reset===true||b.applyToAll===true)run('DELETE FROM chat_preferences WHERE user_id=?',uid);run('INSERT OR REPLACE INTO preferences VALUES(?,?)',uid,JSON.stringify(p));notify(uid);for(const c of all('SELECT chat_id FROM members WHERE user_id=?',uid))event(c.chat_id);send(p);return true}
  const cp=path.match(/^\/api\/chats\/(\d+)\/appearance$/);
  if(cp){const cid=Number(cp[1]);access(cid);const old=JSON.parse(get('SELECT value FROM chat_preferences WHERE user_id=? AND chat_id=?',uid,cid)?.value||'{}');if(method==='GET'){send(old);return true}if(method==='PATCH'){const b=await json();access(cid);const p=b.reset?{}:settings(b,old,uid);run('INSERT OR REPLACE INTO chat_preferences VALUES(?,?,?)',uid,cid,JSON.stringify(p));notify(uid);send(p);return true}}
  if(path==='/api/profile-media'&&method==='POST'){
   limit('media:'+uid,12);const kind=req.headers['x-media-kind'];if(!['avatar','banner','background'].includes(kind))fail(400,'Укажите тип изображения');
   const bytes=await body(req,kind==='avatar'?2*1024*1024:8*1024*1024),mime=imageMime(bytes);if(!mime||kind==='avatar'&&mime==='image/gif')fail(400,'Нужен PNG, JPEG или WebP; GIF доступен для баннера и фона');
   if(get('SELECT COALESCE(sum(size),0) size FROM profile_media WHERE user_id=?',uid).size+bytes.length>100*1024*1024)fail(413,'Лимит медиа профиля 100 МБ. Обратитесь к администратору для очистки неиспользуемых изображений');
   if(!get('SELECT 1 FROM sessions WHERE token=? AND expires>?',ctx.token,Date.now()))fail(401,'Войдите в аккаунт');const id=randomBytes(20).toString('hex');writeFileSync(join(data,'uploads',id),bytes,{flag:'wx'});run('INSERT INTO profile_media VALUES(?,?,?,?,?)',id,uid,kind,mime,bytes.length);send({id,mime,x:50,y:50,zoom:1});return true;
  }
  if(path==='/api/profile-media/unused'&&method==='DELETE'){
   const refs=[get('SELECT profile FROM users WHERE id=?',uid).profile,get('SELECT value FROM preferences WHERE user_id=?',uid)?.value||'',...all('SELECT value FROM chat_preferences WHERE user_id=?',uid).map(x=>x.value),...all('SELECT value FROM group_profiles').map(x=>x.value)].join(' ');let removed=0;
   for(const m of all('SELECT * FROM profile_media WHERE user_id=?',uid))if(!refs.includes(m.id)){try{unlinkSync(join(data,'uploads',m.id))}catch(e){if(e.code!=='ENOENT')throw e}run('DELETE FROM profile_media WHERE id=?',m.id);removed++}send({removed});return true;
  }
  const fm=path.match(/^\/api\/profile-media\/([a-f0-9]{40})$/);
  if(fm&&method==='GET'){
   const m=get('SELECT * FROM profile_media WHERE id=?',fm[1]);if(!m||m.kind==='background'&&m.user_id!==uid)fail(404,'Изображение не найдено');
   res.setHeader('Content-Type',m.mime);res.setHeader('Content-Disposition','inline');const stream=createReadStream(join(data,'uploads',m.id));stream.on('error',()=>{if(!res.headersSent)res.writeHead(404);res.end()});stream.pipe(res);return true;
  }
  return false;
 }
 return {handle,crop,profile,summary,relation,pulse,forget,presence};
}
