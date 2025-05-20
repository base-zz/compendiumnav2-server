import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '../src/signalk_dev.db');

// Open the database
const db = new sqlite3.Database(dbPath);

async function viewFilteredData() {
  try {
    console.log('=== Filtered Table Information ===');
    
    // Get record counts
    const counts = await new Promise((resolve) => {
      db.get(
        `SELECT 
          (SELECT COUNT(*) FROM sk_patches) as total_records,
          (SELECT COUNT(*) FROM sk_patches_filtered) as filtered_records`,
        (err, row) => {
          if (err) {
            console.error('Error getting record counts:', err.message);
            resolve({ total_records: 0, filtered_records: 0 });
          } else {
            resolve(row || { total_records: 0, filtered_records: 0 });
          }
        }
      );
    });
    
    console.log(`Total records in original table: ${counts.total_records}`);
    console.log(`Records in filtered table: ${counts.filtered_records}`);
    console.log(`Filtered out: ${counts.total_records - counts.filtered_records} records`);
    
    // Get sample of filtered records
    console.log('\n=== Sample of Filtered Records ===');
    const sample = await new Promise((resolve) => {
      db.all(
        'SELECT timestamp, patch_json, source FROM sk_patches_filtered ORDER BY timestamp ASC LIMIT 5',
        [],
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
    
    console.log(`\nFirst ${sample.length} filtered records:`);
    console.log('--------------------------------------');
    
    sample.forEach((record, index) => {
      console.log(`\nRecord ${index + 1}:`);
      console.log(`Timestamp: ${record.timestamp}`);
      console.log(`Source: ${record.source || 'N/A'}`);
      console.log('Patch Operations:');
      
      try {
        const operations = JSON.parse(record.patch_json);
        console.log(`Number of operations: ${operations.length}`);
        
        // Show first operation details
        if (operations.length > 0) {
          const firstOp = operations[0];
          console.log('\nFirst operation:');
          console.log(`- Path: ${firstOp.path}`);
          console.log(`- Operation: ${firstOp.op}`);
          
          if (firstOp.value !== undefined) {
            const valueStr = typeof firstOp.value === 'object' 
              ? JSON.stringify(firstOp.value).substring(0, 150) + '...' 
              : firstOp.value;
            console.log(`- Value: ${valueStr}`);
          }
        }
        
        // Count operation types
        const opCounts = operations.reduce((acc, op) => {
          acc[op.op] = (acc[op.op] || 0) + 1;
          return acc;
        }, {});
        
        console.log('\nOperation counts:');
        console.table(Object.entries(opCounts).map(([op, count]) => ({
          operation: op,
          count,
          percentage: ((count / operations.length) * 100).toFixed(1) + '%'
        })));
        
      } catch (e) {
        console.error('Error parsing patch JSON:', e.message);
      }
    });
    
    // Get some statistics about the filtered data
    console.log('\n=== Filtered Data Statistics ===');
    
    // Count operations by path pattern
    const pathStats = await new Promise((resolve) => {
      db.all(
        `WITH RECURSIVE 
        split_patches AS (
          SELECT 
            json_extract(j.value, '$.path') as path,
            json_extract(j.value, '$.op') as op
          FROM sk_patches_filtered,
          json_each(sk_patches_filtered.patch_json) as j
          LIMIT 1000  -- Limit to first 1000 operations for performance
        )
        SELECT 
          path,
          op,
          COUNT(*) as count,
          ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM split_patches), 2) as percentage
        FROM split_patches
        GROUP BY path, op
        ORDER BY count DESC
        LIMIT 10`,
        [],
        (err, rows) => {
          if (err) {
            console.error('Error getting path statistics:', err.message);
            resolve([]);
          } else {
            resolve(rows || []);
          }
        }
      );
    });
    
    console.log('\nMost common operation paths:');
    console.table(pathStats);
    
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run the viewer
viewFilteredData()
  .then(() => {
    console.log('\nDone!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  })
  .finally(() => {
    // Close the database connection
    db.close();
  });
