# Encrypted Bluetooth Devices (e.g., Victron)

Some Bluetooth devices encrypt their advertisement data for security. This guide explains how to add encrypted devices to your system.

## How It Works

1. **Device broadcasts encrypted data** via Bluetooth
2. **User adds device** through your UI and provides the encryption key
3. **Encryption key is stored** in device metadata
4. **Parser automatically decrypts** data using the stored key
5. **Parsed data flows** into your state system

## For Users: Adding a Victron SmartBMV

### Step 1: Get Your Encryption Key

Open the Victron Connect app:
1. Connect to your SmartBMV device
2. Go to **Product Info**
3. Copy the **Instant readout via Bluetooth** key
4. It will be a 32-character hex string like: `d020496a21cf5db1e5ad2c647d1ec72d`

### Step 2: Add Device in Your App

When you select/add the Victron device in your UI:
1. The app will detect it requires an encryption key
2. Enter the encryption key you copied
3. The key is saved to device metadata
4. Data will start flowing immediately!

## For Developers: How the System Works

### Device Metadata Storage

When a user adds an encrypted device, store the key in metadata:

```javascript
await deviceManager.updateDeviceMetadata(deviceId, {
  encryptionKey: 'd020496a21cf5db1e5ad2c647d1ec72d'
});
```

### Automatic Decryption

The BluetoothService automatically:
1. Retrieves the encryption key from device metadata
2. Passes it to the parser
3. Parser decrypts and parses the data

```javascript
// In BluetoothService._parseManufacturerData()
const device = this.deviceManager.getDevice(deviceId);
const encryptionKey = device?.metadata?.encryptionKey;
const parseOptions = encryptionKey ? { encryptionKey } : {};
const result = parser.parse(manufacturerData, parseOptions);
```

### Parser Configuration

Encrypted device configs specify encryption requirements:

```json
{
  "manufacturerId": 737,
  "name": "Victron SmartBMV",
  "encryptionKey": null,
  "requiresEncryptionKey": true,
  "encryption": {
    "algorithm": "aes-128-ctr",
    "nonceOffset": 0,
    "dataOffset": 1
  },
  "formats": [...]
}
```

## UI Implementation Example

### Frontend: Device Selection

```javascript
// When user selects a Victron device
async function selectDevice(deviceId) {
  // Check if device requires encryption key
  const deviceInfo = await getDeviceInfo(deviceId);
  
  if (deviceInfo.requiresEncryptionKey) {
    // Prompt user for encryption key
    const encryptionKey = await promptForEncryptionKey();
    
    // Save to device metadata
    await updateDeviceMetadata(deviceId, {
      encryptionKey: encryptionKey
    });
  }
  
  // Select the device
  await selectBluetoothDevice(deviceId);
}
```

### Backend: API Endpoint

```javascript
// Add endpoint to update device metadata
app.post('/api/bluetooth/devices/:id/metadata', async (req, res) => {
  const { id } = req.params;
  const { encryptionKey } = req.body;
  
  await deviceManager.updateDeviceMetadata(id, {
    encryptionKey: encryptionKey
  });
  
  res.json({ success: true });
});
```

## Supported Encrypted Devices

Currently supported:
- **Victron SmartBMV** (Battery Monitor)
- **Victron SmartShunt**
- **Victron SmartSolar** (Solar Charger)
- Other Victron devices with BLE

## Adding New Encrypted Devices

To add support for a new encrypted device:

1. Create a config file in `configs/` directory
2. Set `requiresEncryptionKey: true`
3. Define the `encryption` algorithm and parameters
4. Define the data `formats` for parsing decrypted data
5. Users will be prompted for the key when adding the device

## Security Notes

- Encryption keys are stored in device metadata (local database)
- Keys are never transmitted to the VPS (unless you explicitly implement that)
- Each device has its own unique encryption key
- Keys are device-specific and cannot be reused

## Troubleshooting

**"Encryption key required but not provided"**
- User hasn't entered the encryption key yet
- Prompt them to add it through device settings

**"Decryption failed"**
- Wrong encryption key entered
- Ask user to verify the key from Victron Connect app

**No data appearing**
- Check that device is selected
- Verify encryption key is correct
- Check console logs for decryption errors
