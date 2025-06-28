// parsers/ruuvi.js
export default class RuuviParser {
  static manufacturerId = 0x0499;

  static parse(data) {
    const payload = data.slice(2);
    const format = payload[0];

    switch (format) {
      case 3: return this.parseRAWv1(payload);
      case 5: return this.parseRAWv2(payload);
      default: return null;
    }
  }


  static parseRAWv1(data) {
    if (data.length < 15) return null;

    const tempIntegral = data.readInt8(1);
    const tempFraction = data[2];
    const temperature = tempIntegral + (tempFraction / 100);

    const humidity = data[3] * 0.5;
    const pressure = data.readUInt16BE(4) + 500;
    const accelerationX = data.readInt16BE(6);
    const accelerationY = data.readInt16BE(8);
    const accelerationZ = data.readInt16BE(10);
    const batteryVoltage = data.readUInt16BE(12) / 1000; // Convert to volts

    return {
      dataFormat: 3,
      temperature: temperature.toFixed(2) + ' °C',
      fahrenheit: (temperature * 9 / 5 + 32).toFixed(2) + ' °F',
      humidity: humidity.toFixed(1) + '%',
      pressure: pressure.toFixed(0) + ' hPa',
      acceleration: {
        x: accelerationX,
        y: accelerationY,
        z: accelerationZ
      },
      batteryVoltage: batteryVoltage + ' mV'
    };

  }



  static parseRAWv2(data) {
    if (data.length < 24) return null;

    const temperature = data.readInt16BE(1) * 0.005;
    const humidity = data.readUInt16BE(3) * 0.0025;
    const pressure = data.readUInt16BE(5) + 50000;

    const accelerationX = data.readInt16BE(7) / 1000;
    const accelerationY = data.readInt16BE(9) / 1000;
    const accelerationZ = data.readInt16BE(11) / 1000;

    const powerInfo = data.readUInt16BE(13);
    const batteryVoltage = (powerInfo >> 5) + 1600;
    const txPower = (powerInfo & 0x1F) * 2 - 40;

    const movementCounter = data[15];
    const sequenceNumber = data.readUInt16BE(16);
    const macAddress = data.slice(18, 24).toString('hex').toUpperCase();

    return {
      dataFormat: 5,
      temperature: temperature.toFixed(2) + ' °C',
      fahrenheit: (temperature * 9 / 5 + 32).toFixed(2) + ' °F',
      humidity: humidity.toFixed(2) + '%',
      pressure: (pressure / 100).toFixed(2) + ' hPa',
      acceleration: {
        x: accelerationX.toFixed(3) + ' g',
        y: accelerationY.toFixed(3) + ' g',
        z: accelerationZ.toFixed(3) + ' g'
      },
      batteryVoltage: batteryVoltage + ' mV',
      txPower: txPower + ' dBm',
      movementCounter: movementCounter,
      sequenceNumber: sequenceNumber,
      macAddress: macAddress.match(/.{1,2}/g).join(':')
    };
  }

  static parseRuuviManufacturerData(data) {
    if (!data || data.length < 2) return null;

    const companyId = data.readUInt16LE(0);
    if (companyId !== 0x0499) return null; // Not Ruuvi

    const payload = data.slice(2); // Skip company ID
    if (payload.length < 1) return null;

    const dataFormat = payload[0];

    switch (dataFormat) {
      case 3: return this.parseRAWv1(payload);
      case 5: return this.parseRAWv2(payload);
      default:
        console.log(`⚠️ Unsupported Ruuvi data format: ${dataFormat}`);
        return null;
    }
  }

}

// Export as default