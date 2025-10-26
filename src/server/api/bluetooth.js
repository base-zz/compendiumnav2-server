import debug from 'debug';

const log = debug('api:bluetooth');

export function registerBluetoothRoutes(app, serviceManager) {
  const bluetoothService = serviceManager.getService('bluetooth');

  if (!bluetoothService) {
    log('Bluetooth service not available, skipping route registration.');
    return;
  }

  app.post('/api/bluetooth/discover', (req, res) => {
    log('Received request to start Bluetooth discovery.');
    try {
      const { duration } = req.body;
      bluetoothService.startDiscovery(duration);
      res.status(200).json({ message: 'Bluetooth discovery started.' });
    } catch (error) {
      log('Error starting Bluetooth discovery:', error);
      res.status(500).json({ error: 'Failed to start Bluetooth discovery.' });
    }
  });

  app.post('/api/bluetooth/devices/:id/metadata', async (req, res) => {
    log('Received request to update device metadata.');
    try {
      const { id } = req.params;
      const metadata = req.body;
      
      log(`Updating metadata for device ${id}:`, metadata);
      
      const success = await bluetoothService.updateBluetoothDeviceMetadata(id, metadata);
      
      if (success) {
        res.status(200).json({ 
          message: 'Device metadata updated successfully.',
          deviceId: id,
          metadata: metadata
        });
      } else {
        res.status(404).json({ error: 'Device not found.' });
      }
    } catch (error) {
      log('Error updating device metadata:', error);
      res.status(500).json({ error: 'Failed to update device metadata.' });
    }
  });

  log('Bluetooth API routes registered.');
}
