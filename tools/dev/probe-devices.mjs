import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('D:/dsh/tide-core/data/gateway.db', { readOnly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log('tables:', tables.map((t) => t.name).join(', '));
for (const t of ['device', 'devices', 'user', 'users']) {
  try {
    const rows = db.prepare(`SELECT * FROM ${t}`).all();
    console.log(`\n[${t}] ${rows.length} 行`);
    for (const r of rows) {
      const { refresh_hash, password_hash, ...rest } = r;
      console.log(' ', JSON.stringify(rest));
    }
  } catch (e) {
    console.log(`\n[${t}] 无: ${e.message}`);
  }
}
db.close();
