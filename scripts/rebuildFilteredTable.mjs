import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '../src/signalk_dev.db');

// Open the database
const db = new sqlite3.Database(dbPath);

async function rebuildFilteredTable() {
  try {
    console.log('Starting to rebuild filtered table...');
    
    // Start a transaction
    await new Promise((resolve, reject) => {
      db.run('BEGIN TRANSACTION', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    // Drop the existing filtered table if it exists
    await new Promise((resolve, reject) => {
      db.run('DROP TABLE IF EXISTS sk_patches_filtered', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    // Create the filtered table with the same structure as the original
    await new Promise((resolve, reject) => {
      db.run(`
        CREATE TABLE sk_patches_filtered (
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          patch_json TEXT NOT NULL,
          source TEXT
        )
      `, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    console.log('Created new filtered table');
    
    // Process patches in batches to avoid memory issues
    const batchSize = 1000;
    let offset = 0;
    let totalProcessed = 0;
    let totalFiltered = 0;
    
    // Get total count for progress tracking
    const totalCount = await new Promise((resolve) => {
      db.get('SELECT COUNT(*) as count FROM sk_patches', (err, row) => {
        if (err) {
          console.error('Error getting count:', err.message);
          resolve(0);
        } else {
          resolve(row?.count || 0);
        }
      });
    });
    
    console.log(`Processing ${totalCount} patches...`);
    
    // Process in batches
    while (true) {
      const batch = await new Promise((resolve) => {
        db.all(
          'SELECT timestamp, patch_json, source FROM sk_patches ORDER BY timestamp LIMIT ? OFFSET ?',
          [batchSize, offset],
          (err, rows) => {
            if (err) {
              console.error('Error fetching batch:', err.message);
              resolve([]);
            } else {
              resolve(rows || []);
            }
          }
        );
      });
      
      if (batch.length === 0) break;
      
      // Process each patch in the batch
      for (const patch of batch) {
        try {
          const operations = JSON.parse(patch.patch_json);
          
          // Filter out operations with null values
          const filteredOps = operations.filter(op => {
            // Keep operations that have a non-null value
            return op.value !== null && op.value !== undefined;
          });
          
          // Only keep patches that still have operations after filtering
          if (filteredOps.length > 0) {
            await new Promise((resolve, reject) => {
              db.run(
                'INSERT INTO sk_patches_filtered (timestamp, patch_json, source) VALUES (?, ?, ?)',
                [patch.timestamp, JSON.stringify(filteredOps), patch.source],
                (err) => {
                  if (err) reject(err);
                  else resolve();
                }
              );
            });
            totalFiltered++;
          }
          
        } catch (e) {
          console.error(`Error processing patch at ${patch.timestamp}:`, e.message);
        }
      }
      
      totalProcessed += batch.length;
      offset += batchSize;
      
      // Log progress
      console.log(`Processed ${totalProcessed}/${totalCount} patches (${Math.round((totalProcessed / totalCount) * 100)}%)`);
      
      // Commit periodically to avoid large transactions
      if (totalProcessed % 10000 === 0) {
        await new Promise((resolve, reject) => {
          db.run('COMMIT', (err) => {
            if (err) reject(err);
            else {
              db.run('BEGIN TRANSACTION', (err2) => {
                if (err2) reject(err2);
                else resolve();
              });
            }
          });
        });
      }
    }
    
    // Commit the final transaction
    await new Promise((resolve, reject) => {
      db.run('COMMIT', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    console.log('\n=== Rebuild Complete ===');
    console.log(`Processed ${totalProcessed} total patches`);
    console.log(`Kept ${totalFiltered} patches after filtering (${Math.round((totalFiltered / totalProcessed) * 100)}%)`);
    
  } catch (error) {
    console.error('Error during rebuild:', error);
    
    // Rollback on error
    await new Promise((resolve) => {
      db.run('ROLLBACK', () => resolve());
    });
    
    throw error;
  }
}

// Run the rebuild
rebuildFilteredTable()
  .then(() => {
    console.log('Filtered table rebuild completed successfully');
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
