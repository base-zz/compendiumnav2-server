// src/server/api/v1/transformers/signalk.transformer.js
export function transformSignalKPosition(position) {
    return {
      coordinates: {
        lat: position.latitude,
        lon: position.longitude,
        source: 'signalk',
        timestamp: position.timestamp
      },
      metadata: {
        speedOverGround: position.sog,
        courseOverGround: position.cog
      }
    };
  }