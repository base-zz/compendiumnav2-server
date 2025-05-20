import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

async function main() {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const dbPath = path.join(__dirname, '../src/signalk_dev.db');
    
    console.log(`Connecting to database: ${dbPath}`);
    
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) {
        console.error('Error opening database:', err.message);
        process.exit(1);
      }
    });
    
    // Check tables
    const tables = await new Promise((resolve, reject) => {
      db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    
    console.log('\n=== Tables in database ===');
    console.table(tables);
    
    if (!tables.some(t => t.name === 'sk_patches')) {
      console.error('Error: sk_patches table not found in database');
      process.exit(1);
    }
    
    // Get record count and sample data
    const count = await new Promise((resolve) => {
      db.get('SELECT COUNT(*) as count FROM sk_patches', (err, row) => {
        if (err) {
          console.error('Error counting records:', err.message);
          resolve(0);
        } else {
          resolve(row?.count || 0);
        }
      });
    });
    
    console.log(`\n=== Record Count ===`);
    console.log(`Total records in sk_patches: ${count}`);
    
    // First, get the table structure
    console.log('\n=== Table Structure ===');
    const tableInfo = await new Promise((resolve) => {
      db.all('PRAGMA table_info(sk_patches)', (err, rows) => {
        if (err) {
          console.error('Error getting table info:', err.message);
          resolve([]);
        } else {
          resolve(rows || []);
        }
      });
    });
    
    console.log('sk_patches table columns:');
    console.table(tableInfo);
    
    // Get the column names
    const columnNames = tableInfo.map(col => `"${col.name}"`).join(', ');
    
    // Check for null values in the first 1000 records
    console.log('\n=== Checking for null values in first 1000 records ===');
    const sampleSize = Math.min(1000, count);
    const sample = await new Promise((resolve) => {
      db.all(
        `SELECT ${columnNames} FROM sk_patches ORDER BY timestamp ASC LIMIT ?`,
        [sampleSize],
        (err, rows) => {
          if (err) {
            console.error('Error fetching sample records:', err.message);
            resolve([]);
          } else {
            resolve(rows || []);
          }
        }
      );
    });
    
    console.log(`\nSample of ${sample.length} records:`);
    
    // Analyze patch data structure and content
    console.log('\n=== Patch Data Analysis ===');
    
    // Track different patch structures
    const patchStructures = new Map();
    const valueTypes = new Map();
    const examplePatches = [];
    
    sample.forEach((record, index) => {
      try {
        const patch = JSON.parse(record.patch_json);
        
        // Collect a few examples
        if (examplePatches.length < 3) {
          examplePatches.push({
            timestamp: record.timestamp,
            source: record.source,
            patch: patch
          });
        }
        
        // Analyze patch structure
        const structure = JSON.stringify(patch, (key, value) => {
          if (key === 'value') {
            const type = value === null ? 'null' : typeof value;
            valueTypes.set(type, (valueTypes.get(type) || 0) + 1);
          }
          return key === 'value' ? undefined : value;
        });
        
        patchStructures.set(structure, (patchStructures.get(structure) || 0) + 1);
        
      } catch (e) {
        console.error(`Error parsing record at ${record.timestamp}:`, e.message);
      }
    });
    
    // Show patch structure statistics
    console.log('\n=== Patch Structure Statistics ===');
    console.log(`Unique patch structures: ${patchStructures.size}`);
    
    // Show most common structures
    const sortedStructures = Array.from(patchStructures.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    
    console.log('\nMost common patch structures:');
    sortedStructures.forEach(([structure, count], i) => {
      console.log(`\nStructure ${i + 1} (${count} records):`);
      console.log(JSON.stringify(JSON.parse(structure), null, 2));
    });
    
    // Show value types
    console.log('\n=== Value Types ===');
    console.table(Array.from(valueTypes.entries()).map(([type, count]) => ({
      type,
      count,
      percentage: ((count / sampleSize) * 100).toFixed(1) + '%'
    })));
    
    // Show example patches
    console.log('\n=== Example Patches ===');
    examplePatches.forEach((example, i) => {
      console.log(`\nExample ${i + 1}:`);
      console.log(`Timestamp: ${example.timestamp}`);
      console.log(`Source: ${example.source || 'N/A'}`);
      console.log('Patch data:');
      console.log(JSON.stringify(example.patch, null, 2));
    });
    
    // Check for position data specifically
    const positionPatches = sample.filter(record => {
      try {
        const patch = JSON.parse(record.patch_json);
        return JSON.stringify(patch).includes('navigation.position');
      } catch (e) {
        return false;
      }
    });
    
    console.log(`\n=== Position Data ===`);
    console.log(`Found ${positionPatches.length} patches with position data in sample`);
    
    if (positionPatches.length > 0) {
      console.log('\nExample position patch:');
      const example = positionPatches[0];
      console.log(`Timestamp: ${example.timestamp}`);
      console.log(JSON.stringify(JSON.parse(example.patch_json), null, 2));
    }
    
    // Close the database connection
    db.close();
    
    console.log('\nDone!');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
