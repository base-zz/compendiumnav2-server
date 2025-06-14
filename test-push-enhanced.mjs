// test-push-enhanced.mjs - Enhanced APNS Test Script with Sandbox Mode
import apn from '@parse/node-apn';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import dotenv from 'dotenv';

// Setup environment
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '.env') });

// Force sandbox for testing
process.env.APNS_PRODUCTION = 'false';

// Configuration
const config = {
  keyId: process.env.APNS_KEY_ID,
  teamId: process.env.APNS_TEAM_ID,
  keyFile: process.env.APNS_KEY_FILE,
  topic: process.env.APNS_TOPIC,
  isProduction: false, // Force sandbox
  deviceToken: process.env.DEVICE_TOKEN
};

// Debug info
console.log('=== APNS Configuration ===');
console.log('Environment:', config.isProduction ? 'Production' : 'Sandbox (Development)');
console.log('Key File:', resolve(__dirname, config.keyFile));
console.log('Key ID:', config.keyId);
console.log('Team ID:', config.teamId);
console.log('Topic:', config.topic);
console.log('Device Token:', config.deviceToken);
console.log('===========================');

// Initialize provider
const apnProvider = new apn.Provider({
  token: {
    key: resolve(__dirname, config.keyFile),
    keyId: config.keyId,
    teamId: config.teamId
  },
  production: config.isProduction
});

// Create notification
const notification = new apn.Notification({
  alert: 'Test Push from Enhanced Script',
  topic: config.topic,
  payload: {
    aps: {
      alert: 'Test Push',
      sound: 'default',
      badge: 1
    },
    test: true,
    timestamp: new Date().toISOString()
  }
});

// Send notification
console.log('\nSending test notification...');
try {
  const response = await apnProvider.send(notification, config.deviceToken);
  console.log('\n✅ Notification sent!');
  console.log(JSON.stringify(response, null, 2));
  
  if (response.failed?.length) {
    console.log('\n❌ Failures:');
    response.failed.forEach(f => {
      console.log(`- Device: ${f.device}`);
      console.log(`  Status: ${f.status}`);
      console.log(`  Error: ${f.response?.reason || 'Unknown error'}`);
    });
  }
} catch (error) {
  console.error('\n❌ Error sending notification:');
  console.error(error);
} finally {
  apnProvider.shutdown();
}
