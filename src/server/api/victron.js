import debug from 'debug';
console.log('[ROUTES] Victron routes module loaded');
import storageService from '../../bluetooth/services/storage/storageService.js';

const log = debug('api:victron');

export function registerVictronRoutes(app, victronModbusService) {
  if (!victronModbusService) {
    log('Victron Modbus service not available, skipping route registration.');
    return;
  }

  /**
   * POST /api/victron/rescan
   * Triggers a rescan of all Modbus Unit IDs to discover new devices
   */
  app.post('/api/victron/rescan', async (req, res) => {
    log('Received request to rescan Victron Modbus devices.');
    try {
      // Clear saved Unit IDs
      await storageService.setSetting('victronModbusUnitIds', null);
      log('Cleared saved Unit IDs');
      
      // Stop current polling
      victronModbusService._stopPolling();
      log('Stopped polling');
      
      // Run discovery
      log('Starting device discovery...');
      await victronModbusService._discoverDevices();
      
      // Save new Unit IDs
      if (victronModbusService.discoveredDevices && victronModbusService.discoveredDevices.length > 0) {
        await storageService.setSetting('victronModbusUnitIds', victronModbusService.discoveredDevices);
        log('Saved new Unit IDs:', victronModbusService.discoveredDevices);
      }
      
      // Restart polling
      victronModbusService._startPolling();
      log('Restarted polling');
      
      res.status(200).json({ 
        message: 'Victron device rescan completed.',
        devicesFound: victronModbusService.discoveredDevices.length,
        devices: victronModbusService.discoveredDevices
      });
    } catch (error) {
      log('Error rescanning Victron devices:', error);
      res.status(500).json({ error: 'Failed to rescan Victron devices: ' + error.message });
    }
  });

  /**
   * GET /api/victron/devices
   * Returns currently discovered Victron devices
   */
  app.get('/api/victron/devices', async (req, res) => {
    try {
      const savedUnitIds = await storageService.getSetting('victronModbusUnitIds');
      res.status(200).json({
        devices: savedUnitIds || [],
        count: savedUnitIds ? savedUnitIds.length : 0
      });
    } catch (error) {
      log('Error getting Victron devices:', error);
      res.status(500).json({ error: 'Failed to get Victron devices.' });
    }
  });

  log('Victron API routes registered.');
}
