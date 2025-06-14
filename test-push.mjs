// test-push.mjs - APNS Test Push Notification Script
import apn from '@parse/node-apn';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import dotenv from 'dotenv';

// Setup environment and paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '.env') });

// APNS Configuration from environment
const config = {
  keyId: process.env.APNS_KEY_ID,
  teamId: process.env.APNS_TEAM_ID,
  keyFile: process.env.APNS_KEY_FILE,
  topic: process.env.APNS_TOPIC,
  isProduction: process.env.APNS_PRODUCTION === 'true',
  deviceToken: process.env.DEVICE_TOKEN // Set this in your .env
};

// Validate configuration
const missing = Object.entries(config)
  .filter(([key, value]) => !value && key !== 'isProduction')
  .map(([key]) => key);

if (missing.length > 0) {
  console.error('Missing required configuration in .env:', missing.join(', '));
  process.exit(1);
}

// Initialize APN provider
const apnProvider = new apn.Provider({
  token: {
    key: resolve(__dirname, config.keyFile),
    keyId: config.keyId,
    teamId: config.teamId
  },
  production: config.isProduction
});

// Create a test notification
const notification = new apn.Notification({
  alert: 'Test Push Notification',
  topic: config.topic,
  payload: {
    aps: {
      'content-available': 1,
      sound: 'default',
      badge: 1
    },
    customData: {
      test: true,
      timestamp: new Date().toISOString()
    }
  }
});

// Send the notification
console.log('Sending test push notification...');
console.log('Target Device:', config.deviceToken);
console.log('Using APNS Key:', config.keyFile);
console.log('Environment:', config.isProduction ? 'Production' : 'Sandbox');

try {
  const response = await apnProvider.send(notification, config.deviceToken);
  
  console.log('\n✅ Notification sent successfully!');
  console.log('Response:', JSON.stringify(response, null, 2));
  
  if (response.failed && response.failed.length > 0) {
    console.error('\n❌ Failed to send to some devices:');
    response.failed.forEach(failure => {
      console.error(`Device: ${failure.device}, Error: ${failure.error}`);
    });
  }
} catch (error) {
  console.error('\n❌ Error sending notification:');
  console.error(error);
  process.exit(1);
} finally {
  // Close the provider to avoid hanging
  apnProvider.shutdown();
  process.exit(0);
}
