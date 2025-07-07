import debug from 'debug';

const log = debug('cn2:api:bluetooth');

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

  log('Bluetooth API routes registered.');
}
