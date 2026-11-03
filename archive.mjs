import {randomBytes,scrypt as scryptCb,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(scryptCb);
const error=(code,message)=>{throw Object.assign(new Error(message),{code})};
export function archive(db,notify,limit){
 const get=(s,...p)=>db.prepare(s).get(...p),all=(s,...p)=>db.prepare(s).all(...p),run=(s,...p)=>db.prepare(s).run(...p);
 const folder=(id,uid)=>get('SELECT * FROM archive_folders WHERE id=? AND user_id=?',id,uid)||error(404,'Папка не найдена');
 function root(uid){run("INSERT OR IGNORE INTO archive_folders(user_id,name,root) VALUES(?,'Архив',1)",uid);return get('SELECT * FROM archive_folders WHERE user_id=? AND root=1',uid)}
 function chain(id,uid){const result=[],seen=new Set();while(id){if(seen.has(id)||seen.size>=10)error(409,'Некорректная структура архива');seen.add(id);const f=folder(id,uid);result.push(f);id=f.parent_id}return result}
 function allowed(id,uid,token){return chain(id,uid).every(f=>!f.password||get('SELECT 1 FROM folder_grants WHERE token=? AND folder_id=? AND expires>?',token,f.id,Date.now()))}
 function assertFolder(id,uid,token){if(!allowed(id,uid,token))error(423,'Откройте архив паролем')}
 function chatFolder(cid,uid){return get('SELECT folder_id FROM archived_chats WHERE user_id=? AND chat_id=?',uid,cid)?.folder_id||null}
 function canChat(cid,uid,token){const id=chatFolder(cid,uid);return !id||allowed(id,uid,token)}
 function assertChat(cid,uid,token){if(!canChat(cid,uid,token))error(423,'Переписка находится в закрытом архиве')}
 function fingerprint(uid,token){return all('SELECT g.folder_id,g.expires FROM folder_grants g JOIN archive_folders f ON f.id=g.folder_id WHERE token=? AND f.user_id=? AND expires>? ORDER BY g.folder_id',token,uid,Date.now()).map(x=>x.folder_id+':'+x.expires).join(',')}
 async function check(password,stored){if(typeof password!=='string'||password.length>128)return false;const [salt,hex]=stored.split(':');const derived=Buffer.from(await scrypt(password,salt,64)),expected=Buffer.from(hex,'hex');return derived.length===expected.length&&timingSafeEqual(derived,expected)}
 async function hash(password){if(typeof password!=='string'||password.length<6||password.length>128)error(400,'Пароль папки: от 6 до 128 символов');const salt=randomBytes(16).toString('hex');return salt+':'+Buffer.from(await scrypt(password,salt,64)).toString('hex')}
 async function handle({path,method,uid,token,json,send,access}){
  if(!path.startsWith('/api/archive'))return false;
  const rt=root(uid);
  if(path==='/api/archive'&&method==='GET'){
   const list=all('SELECT * FROM archive_folders WHERE user_id=? ORDER BY root DESC,id',uid).filter(f=>!f.parent_id||allowed(f.parent_id,uid,token));
   send(list.map(f=>({id:f.id,parentId:f.parent_id,name:f.name,root:!!f.root,protected:!!f.password,locked:!allowed(f.id,uid,token)})));return true;
  }
  if(path==='/api/archive'&&method==='POST'){
   const b=await json(),parent=Number(b.parentId)||rt.id;assertFolder(parent,uid,token);
   if(chain(parent,uid).length>=8||get('SELECT count(*) n FROM archive_folders WHERE user_id=?',uid).n>=40)error(400,'Лимит: 40 папок и 8 уровней');
   if(typeof b.name!=='string'||!b.name.trim()||b.name.trim().length>50)error(400,'Название папки: 1–50 символов');
   const pw=b.password?await hash(b.password):null;assertFolder(parent,uid,token);
   if(get('SELECT count(*) n FROM archive_folders WHERE user_id=?',uid).n>=40)error(400,'Лимит: 40 папок');
   const id=Number(run('INSERT INTO archive_folders(user_id,parent_id,name,password) VALUES(?,?,?,?)',uid,parent,b.name.trim(),pw).lastInsertRowid);notify(uid);send({id});return true;
  }
  if(path==='/api/archive/lock'&&method==='POST'){run('DELETE FROM folder_grants WHERE token=?',token);notify(uid);send({ok:true});return true}
  const fm=path.match(/^\/api\/archive\/(\d+)(?:\/(unlock|password))?$/);
  if(fm){const f=folder(Number(fm[1]),uid),action=fm[2];
   if(action==='unlock'&&method==='POST'){
    if(f.parent_id)assertFolder(f.parent_id,uid,token);limit('vault:'+uid,8);const b=await json();
    if(f.password&&!await check(b.password,f.password))error(403,'Неверный пароль папки');
    if(f.parent_id)assertFolder(f.parent_id,uid,token);
    if(folder(f.id,uid).password!==f.password)error(409,'Пароль изменён, повторите вход');
    run('INSERT OR REPLACE INTO folder_grants VALUES(?,?,?)',token,f.id,Date.now()+15*60000);notify(uid);send({ok:true});return true;
   }
   if(action==='password'&&method==='PATCH'){
    assertFolder(f.id,uid,token);limit('vault:'+uid,8);const b=await json();
    if(f.password&&!await check(b.currentPassword,f.password))error(403,'Введите текущий пароль папки');
    const password=b.password===''?null:await hash(b.password);assertFolder(f.id,uid,token);
    if(folder(f.id,uid).password!==f.password)error(409,'Пароль уже изменён');
    run('UPDATE archive_folders SET password=? WHERE id=?',password,f.id);
    // Revokes every device, including descendants accessible through the parent.
    for(const candidate of all('SELECT id FROM archive_folders WHERE user_id=?',uid))if(chain(candidate.id,uid).some(x=>x.id===f.id))run('DELETE FROM folder_grants WHERE folder_id=?',candidate.id);
    notify(uid);send({ok:true});return true;
   }
   if(!action&&method==='PATCH'){assertFolder(f.id,uid,token);const b=await json();assertFolder(f.id,uid,token);if(f.root)error(400,'Корневая папка называется Архив');if(typeof b.name!=='string'||!b.name.trim()||b.name.length>50)error(400,'Название: 1–50 символов');run('UPDATE archive_folders SET name=? WHERE id=?',b.name.trim(),f.id);notify(uid);send({ok:true});return true}
   if(!action&&method==='DELETE'){assertFolder(f.id,uid,token);if(f.root)error(400,'Корневую папку нельзя удалить');if(get('SELECT 1 FROM archive_folders WHERE parent_id=?',f.id)||get('SELECT 1 FROM archived_chats WHERE folder_id=?',f.id))error(409,'Сначала переместите чаты и удалите вложенные папки');run('DELETE FROM folder_grants WHERE folder_id=?',f.id);run('DELETE FROM archive_folders WHERE id=?',f.id);notify(uid);send({ok:true});return true}
  }
  const cm=path.match(/^\/api\/archive\/chats\/(\d+)$/);
  if(cm&&method==='PATCH'){
   const cid=Number(cm[1]);access(cid);const b=await json();access(cid);
   if(b.folderId===null)run('DELETE FROM archived_chats WHERE user_id=? AND chat_id=?',uid,cid);
   else {const target=Number(b.folderId)||rt.id;assertFolder(target,uid,token);run('INSERT OR REPLACE INTO archived_chats VALUES(?,?,?)',uid,cid,target)}
   notify(uid);send({ok:true});return true;
  }
  error(405,'Недопустимый метод архива');
 }
 return {handle,canChat,assertChat,chatFolder,fingerprint};
}
