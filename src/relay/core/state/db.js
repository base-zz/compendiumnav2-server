import sqlite3 from 'sqlite3';

// Initialize database
const dbPath = process.env.DATABASE_PATH || '/Users/basselabul-hajj/compendiumnav2-server/signalk_dev.db';
console.log('[DB] Using database at:', dbPath);
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Connected to SQLite database');
  }
});


// Initialize tables
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS sk_patches (
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      patch_json TEXT NOT NULL,
      source TEXT
    )`,
    (err) => err && console.error("Patch table error:", err)
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS full_state (
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      data TEXT NOT NULL
    )`,
    (err) => err && console.error("State table error:", err)
  );

  // Indexes
  db.run("CREATE INDEX IF NOT EXISTS idx_patches_time ON sk_patches(timestamp)");
});

// Prepared statements (reused)
const patchStmt = db.prepare("INSERT INTO sk_patches (patch_json, source) VALUES (?, ?)");
const stateStmt = db.prepare("INSERT INTO full_state (data) VALUES (?)");

// Export functions
 
 export function recordPatch(patchArray, source = "app") {
    if (!Array.isArray(patchArray)) return;
    patchStmt.run(JSON.stringify(patchArray), source);
  }
  
  export function recordFullState(state) {
    stateStmt.run(JSON.stringify(state));
  }

  // Optional: Query helpers
  export function getRecentPatches(limit = 100) {
    return new Promise((resolve) => {
      db.all(
        "SELECT * FROM sk_patches ORDER BY timestamp DESC LIMIT ?",
        [limit],
        (err, rows) => resolve(rows || [])
      );
    });
  }