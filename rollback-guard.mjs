// Pre-1.2 servers do not know archive passwords. Never silently bypass them on rollback.
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync(process.argv[2]||'/app/data/persona.sqlite',{readOnly:true});
const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='archive_folders'").get();
if(exists&&db.prepare('SELECT 1 FROM archive_folders WHERE password IS NOT NULL LIMIT 1').get()){
 console.error('Rollback refused: password-protected archive folders exist. Use an archive-aware image (1.2+) or plan an isolated restore. The current volume was not changed.');
 db.close();process.exit(2);
}
for(const table of ['group_profiles','group_roles','privacy','checkins'])if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)&&db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()){console.error('Rollback refused: Persona 1.3 permissions/privacy/check-ins are in use. Use a compatible recovery image.');db.close();process.exit(2)}
db.close();console.log('Rollback check: no password-protected archive folders');
