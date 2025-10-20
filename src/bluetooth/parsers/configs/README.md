# Bluetooth Device Parser Configurations

This directory contains JSON configuration files for parsing Bluetooth Low Energy (BLE) manufacturer data from various devices.

## Overview

Instead of writing custom parser code for each Bluetooth device, you can simply create a JSON configuration file that describes how to parse the device's data format. The `ConfigurableParser` will automatically handle the parsing based on your configuration.

## Adding a New Device

To add support for a new Bluetooth device:

1. Create a new JSON file in this directory (e.g., `mydevice.json`)
2. Define the device's manufacturer ID and data format
3. Restart the server - the parser will be automatically loaded

## Configuration Format

```json
{
  "manufacturerId": 1177,
  "name": "DeviceName",
  "description": "Device description",
  "formatField": {
    "offset": 0,
    "length": 1,
    "type": "uint8"
  },
  "formats": [
    {
      "version": 1,
      "formatName": "device/format1",
      "minLength": 10,
      "description": "Format description",
      "fields": [
        {
          "name": "temperature",
          "offset": 1,
          "length": 2,
          "type": "int16",
          "endian": "BE",
          "scale": 0.01,
          "unit": "°C"
        }
      ]
    }
  ]
}
```

## Configuration Fields

### Root Level

- **manufacturerId** (number, required): The Bluetooth manufacturer ID (decimal)
- **name** (string, required): Human-readable device name
- **description** (string, optional): Device description
- **formatField** (object, optional): Field that indicates which format version to use
- **formats** (array, required): Array of format definitions

### Format Definition

- **version** (number, required): Format version number
- **formatName** (string, optional): Name for this format (e.g., "ruuvi/rawv2")
- **minLength** (number, optional): Minimum payload length required
- **description** (string, optional): Format description
- **fields** (array, required): Array of field definitions

### Field Definition

- **name** (string, required): Field name (use dot notation for nested fields, e.g., "battery.voltage")
- **offset** (number, required): Byte offset in the payload
- **length** (number, required): Number of bytes to read
- **type** (string, required): Data type (see below)
- **endian** (string, optional): "BE" (big-endian) or "LE" (little-endian), default: "BE"
- **scale** (number, optional): Multiply the raw value by this number
- **unit** (string, optional): Unit of measurement (e.g., "°C", "%", "hPa")
- **transform** (object, optional): Additional transformation (see below)

### Supported Data Types

- **int8**: Signed 8-bit integer
- **uint8**: Unsigned 8-bit integer
- **int16**: Signed 16-bit integer
- **uint16**: Unsigned 16-bit integer
- **int32**: Signed 32-bit integer
- **uint32**: Unsigned 32-bit integer
- **buffer**: Raw buffer
- **string**: UTF-8 string
- **hex**: Hexadecimal string
- **mac**: MAC address (formatted with colons)
- **bitfield**: Extract specific bits (requires bitOffset and bitLength)
- **composite**: Combine multiple parts (requires parts array)

### Transform Types

Transforms are applied after scaling:

```json
{
  "transform": {
    "type": "add",
    "value": 50000
  }
}
```

- **add**: Add a constant value
- **multiply**: Multiply by a constant
- **divide**: Divide by a constant
- **formula**: Use a formula (e.g., "(x + 50000) / 100")

### Bitfield Example

Extract specific bits from a byte:

```json
{
  "name": "battery.voltage",
  "offset": 13,
  "length": 2,
  "type": "bitfield",
  "bitOffset": 5,
  "bitLength": 11,
  "transform": {
    "type": "add",
    "value": 1600
  },
  "unit": "mV"
}
```

### Composite Field Example

Combine multiple parts (e.g., temperature with integral and fractional parts):

```json
{
  "name": "temperature",
  "type": "composite",
  "unit": "°C",
  "parts": [
    {
      "offset": 1,
      "length": 1,
      "type": "int8",
      "multiplier": 1
    },
    {
      "offset": 2,
      "length": 1,
      "type": "uint8",
      "multiplier": 0.01
    }
  ]
}
```

## Finding Manufacturer IDs

You can find Bluetooth manufacturer IDs in:
- [Bluetooth SIG Company Identifiers](https://www.bluetooth.com/specifications/assigned-numbers/company-identifiers/)
- Device documentation
- By scanning for the device and checking the logs

## Example: Adding a New Temperature Sensor

Let's say you have a temperature sensor with:
- Manufacturer ID: 0x1234 (4660 in decimal)
- Data format: 2 bytes for temperature (int16, big-endian, scale 0.01)
- Data format: 1 byte for battery (uint8, percentage)

Create `mysensor.json`:

```json
{
  "manufacturerId": 4660,
  "name": "MyTemperatureSensor",
  "description": "Custom temperature sensor",
  "formats": [
    {
      "version": 1,
      "formatName": "mysensor/v1",
      "minLength": 3,
      "fields": [
        {
          "name": "temperature",
          "offset": 0,
          "length": 2,
          "type": "int16",
          "endian": "BE",
          "scale": 0.01,
          "unit": "°C"
        },
        {
          "name": "battery",
          "offset": 2,
          "length": 1,
          "type": "uint8",
          "unit": "%"
        }
      ]
    }
  ]
}
```

That's it! The parser will automatically load and use this configuration.

## Testing Your Configuration

1. Add your JSON file to this directory
2. Restart the server
3. Check the logs for: `Registered [YourDeviceName] for manufacturer ID: 0xXXXX`
4. Scan for your device
5. Check the Bluetooth state logs to verify the parsed data

## Troubleshooting

- **Parser not loading**: Check JSON syntax with a validator
- **Wrong values**: Verify offset, length, type, and endianness
- **Missing fields**: Ensure minLength is correct
- **Scale issues**: Check if the device uses a different scaling factor

## Reference: RuuviTag Configuration

See `ruuvitag.json` for a complete example with:
- Multiple format versions
- Nested fields (acceleration.x, battery.voltage)
- Bitfield extraction
- Composite fields
- Formula transforms
