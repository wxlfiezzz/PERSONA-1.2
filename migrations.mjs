// Additive migrations only. Existing user IDs, password hashes and sessions stay intact.
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function migrate(db) {
  db.exec('PRAGMA busy_timeout=5000');
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied INTEGER NOT NULL)`);
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=1').get()) return;
    db.exec(`
      CREATE TABLE system_accounts(kind TEXT PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE REFERENCES users(id));
      CREATE TABLE releases(id TEXT PRIMARY KEY, body TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE news_chats(user_id INTEGER PRIMARY KEY REFERENCES users(id), chat_id INTEGER NOT NULL UNIQUE REFERENCES chats(id));
      CREATE TABLE release_deliveries(release_id TEXT REFERENCES releases(id), user_id INTEGER REFERENCES users(id), message_id INTEGER REFERENCES messages(id), PRIMARY KEY(release_id,user_id));
      CREATE INDEX members_user ON members(user_id,chat_id);
      CREATE INDEX sessions_expiry ON sessions(expires);
      CREATE INDEX reactions_message ON reactions(message_id);
    `);
    db.prepare('INSERT INTO schema_migrations VALUES(1,?)').run(Date.now());
  });
  transaction(db, () => {
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=2').get()) return;
    db.exec(`
      CREATE TABLE preferences(user_id INTEGER PRIMARY KEY REFERENCES users(id), value TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE chat_preferences(user_id INTEGER REFERENCES users(id),chat_id INTEGER REFERENCES chats(id),value TEXT NOT NULL DEFAULT '{}',PRIMARY KEY(user_id,chat_id));
      CREATE TABLE profile_media(id TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),kind TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL);
      CREATE TABLE archive_folders(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),parent_id INTEGER REFERENCES archive_folders(id),name TEXT NOT NULL,password TEXT,root INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX archive_root ON archive_folders(user_id) WHERE root=1;
      CREATE TABLE archived_chats(user_id INTEGER REFERENCES users(id),chat_id INTEGER REFERENCES chats(id),folder_id INTEGER NOT NULL REFERENCES archive_folders(id),PRIMARY KEY(user_id,chat_id));
      CREATE TABLE folder_grants(token TEXT REFERENCES sessions(token) ON DELETE CASCADE,folder_id INTEGER REFERENCES archive_folders(id),expires INTEGER NOT NULL,PRIMARY KEY(token,folder_id));
      CREATE INDEX archive_user ON archive_folders(user_id,parent_id);
      CREATE INDEX media_owner ON profile_media(user_id);
    `);
    db.prepare('INSERT INTO schema_migrations VALUES(2,?)').run(Date.now());
  });
  transaction(db,()=>{
    if(db.prepare('SELECT 1 FROM schema_migrations WHERE version=3').get())return;
    db.exec(`
      CREATE TABLE group_profiles(chat_id INTEGER PRIMARY KEY REFERENCES chats(id),value TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE group_roles(id INTEGER PRIMARY KEY,chat_id INTEGER NOT NULL REFERENCES chats(id),name TEXT NOT NULL,color TEXT NOT NULL,permissions TEXT NOT NULL);
      CREATE TABLE member_roles(chat_id INTEGER,user_id INTEGER,role_id INTEGER NOT NULL REFERENCES group_roles(id) ON DELETE CASCADE,PRIMARY KEY(chat_id,user_id),FOREIGN KEY(chat_id,user_id) REFERENCES members(chat_id,user_id) ON DELETE CASCADE);
      CREATE TABLE privacy(user_id INTEGER PRIMARY KEY REFERENCES users(id),value TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE checkins(id INTEGER PRIMARY KEY,chat_id INTEGER NOT NULL REFERENCES chats(id),sender INTEGER NOT NULL REFERENCES users(id),recipient INTEGER NOT NULL REFERENCES users(id),created INTEGER NOT NULL,delivered INTEGER,deadline INTEGER,state TEXT NOT NULL DEFAULT 'pending',file_id TEXT REFERENCES files(id));
      CREATE INDEX checkin_sender ON checkins(sender,created);
      CREATE INDEX checkin_recipient ON checkins(recipient,state);
    `);
    db.prepare('INSERT INTO schema_migrations VALUES(3,?)').run(Date.now());
  });

}

export function newsAccount(db) {
  const known = db.prepare("SELECT user_id FROM system_accounts WHERE kind='news'").get();
  if (known) return known.user_id;
  // Never take over an existing human account, even if it already has this name.
  let name = 'persona_news', suffix = 1;
  while (db.prepare('SELECT id FROM users WHERE username=?').get(name)) name = 'persona_news_' + (++suffix);
  const id = Number(db.prepare('INSERT INTO users(username,name,password,profile,created) VALUES(?,?,?,?,?)').run(
    name, 'Persona News', 'disabled:' + '0'.repeat(128),
    JSON.stringify({emoji:'✦',color:'#b8a4ff',bio:'Официальные новости и обновления Persona',status:'Системный аккаунт'}), Date.now()).lastInsertRowid);
  db.prepare("INSERT INTO system_accounts VALUES('news',?)").run(id);
  return id;
}

export function deliverNews(db, uid, releases) {
  const bot = newsAccount(db);
  let cid = db.prepare('SELECT chat_id FROM news_chats WHERE user_id=?').get(uid)?.chat_id;
  for (const release of releases) {
    if (db.prepare('SELECT 1 FROM release_deliveries WHERE release_id=? AND user_id=?').get(release.id, uid)) continue;
    if (!cid) {
      cid = Number(db.prepare("INSERT INTO chats(title,kind,owner,theme) VALUES('Persona News','news',?,'#b8a4ff')").run(bot).lastInsertRowid);
      db.prepare('INSERT INTO news_chats VALUES(?,?)').run(uid,cid);
      db.prepare("INSERT INTO members(chat_id,user_id,role) VALUES(?,?,'owner')").run(cid,bot);
      db.prepare('INSERT INTO members(chat_id,user_id) VALUES(?,?)').run(cid,uid);
    }
    const mid = Number(db.prepare('INSERT INTO messages(chat_id,user_id,body,created,nonce) VALUES(?,?,?,?,?)')
      .run(cid,bot,release.body,Date.now(),'release:'+release.id+':'+uid).lastInsertRowid);
    db.prepare('INSERT INTO release_deliveries VALUES(?,?,?)').run(release.id,uid,mid);
  }
  return cid;
}

export function publishRelease(db, release) {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(release.id) || typeof release.body !== 'string' || !release.body.trim() || release.body.length > 4096) throw Error('Invalid release');
  return transaction(db, () => {
    newsAccount(db);
    const previous = db.prepare('SELECT * FROM releases WHERE id=?').get(release.id);
    if (previous && previous.body !== release.body) throw Error('Release ID already exists with different text. Use a new ID.');
    db.prepare('INSERT OR IGNORE INTO releases VALUES(?,?,?)').run(release.id,release.body,Date.now());
    for (const {id} of db.prepare('SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM system_accounts)').all()) deliverNews(db,id,[release]);
  });
}
