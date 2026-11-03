import {DatabaseSync} from 'node:sqlite';
import {statSync} from 'node:fs';
import {join,dirname} from 'node:path';
import assert from 'node:assert/strict';
const [baseline,candidate]=process.argv.slice(2);
if(!baseline||!candidate)throw Error('Usage: node verify-upgrade.mjs BASELINE_DB CANDIDATE_DB');
const old=new DatabaseSync(baseline,{readOnly:true}),next=new DatabaseSync(candidate,{readOnly:true});
assert.equal(next.prepare('PRAGMA integrity_check').get().integrity_check,'ok','SQLite integrity');
assert.equal(next.prepare('PRAGMA foreign_key_check').all().length,0,'Foreign keys');
for(const table of ['users','sessions','chats','members','messages','files','reactions','blocks','reports','preferences','chat_preferences','profile_media','archive_folders','archived_chats','folder_grants','group_profiles','group_roles','member_roles','privacy','checkins']){
 if(!old.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
 const columns=old.prepare(`PRAGMA table_info(${table})`).all(),keys=columns.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
 const lookup=next.prepare(`SELECT ${columns.map(c=>c.name).join(',')} FROM ${table} WHERE ${keys.map(k=>k+'=?').join(' AND ')}`);
 let count=0;
 for(const row of old.prepare(`SELECT * FROM ${table}${['sessions','folder_grants'].includes(table)?' WHERE expires>'+Date.now():''}`).iterate()){
  assert.deepEqual(lookup.get(...keys.map(k=>row[k])),row,`Changed existing row in ${table}`);count++;
  if(table==='files'||table==='profile_media')assert.equal(statSync(join(dirname(candidate),'uploads',row.id)).size,row.size,'Attachment size');
 }
 console.log(`${table}: ${count} existing rows preserved`);
}
old.close();next.close();console.log('Upgrade verification: OK');
