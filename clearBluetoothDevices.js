#!/usr/bin/env node

/**
 * Clear all Bluetooth devices from LevelDB storage
 * This will force a clean resync of all devices
 */

import PouchDB from 'pouchdb';
import path from 'path';

const basePath = path.join(process.cwd(), 'data');
const devicesDBPath = path.join(basePath, 'devices');

console.log('[CLEAR] Clearing all Bluetooth devices from storage...');
console.log('[CLEAR] Database path:', devicesDBPath);

async function clearDevices() {
  try {
    // Open the devices database
    const devicesDB = new PouchDB(devicesDBPath);
    
    // Get all documents
    const allDocs = await devicesDB.allDocs({ include_docs: true });
    console.log(`[CLEAR] Found ${allDocs.rows.length} documents in database`);
    
    // Delete all documents
    const docsToDelete = allDocs.rows.map(row => ({
      _id: row.id,
      _rev: row.value.rev,
      _deleted: true
    }));
    
    if (docsToDelete.length > 0) {
      const result = await devicesDB.bulkDocs(docsToDelete);
      console.log(`[CLEAR] Deleted ${result.length} documents`);
      console.log('[CLEAR] ✓ All Bluetooth devices cleared successfully');
    } else {
      console.log('[CLEAR] No documents to delete');
    }
    
    // Close the database
    await devicesDB.close();
    
    console.log('[CLEAR] Done! Restart the server to resync devices.');
    process.exit(0);
    
  } catch (error) {
    console.error('[CLEAR] Error clearing devices:', error);
    process.exit(1);
  }
}

clearDevices();
