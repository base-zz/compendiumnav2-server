// DEPRECATED: All SignalK logic migrated to state.controller.js

import { stateService } from '../../state/StateService.js';
import { transformSignalKPosition } from '../transformers/signalk.transformer.js';

/**
 * Get current position directly from SignalK
 */
export const getSignalKPosition = async (req, res) => {
  try {
    // Get position from unified state
    const position = stateService.stateData.navigation?.position;
    if (!position?.latitude || !position?.longitude) {
      return res.status(503).json({
        error: 'SignalK position not available',
        source: stateService.isInitialized ? 'connected' : 'disconnected'
      });
    }
    res.json(transformSignalKPosition(position));
  } catch (err) {
    res.status(502).json({
      error: 'SignalK position request failed',
      details: err.message
    });
  }
};