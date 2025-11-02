// src/server/api/v1/routes.js
import express from 'express';
import { requireService } from '../../services/serviceLocator.js';
import {
  getAnchorState,
  setAnchorPosition,
  updateRodeLength,
  getAnchorHistory,
  getAnchorStatus,
  getNavigationSnapshot,
  getCurrentPosition,
  getCurrentHeading,
  getCurrentSpeed,
  getBatteryStatus,
  getTankLevels,
  getNavigationStatus,
  getSignalKPosition
} from './controllers/state.controller.js';
import { validate } from '../../middleware/validation.js';
import { anchorPositionSchema } from './schemas/anchor.schema.js';

const router = express.Router();

function tryGetStateService() {
  try {
    return requireService('state');
  } catch (error) {
    return null;
  }
}

function respondStateUnavailable(res) {
  return res.status(503).json({
    status: 'error',
    error: 'State service unavailable',
    timestamp: new Date().toISOString()
  });
}

// ======================================
// Service Health Endpoints
// ======================================
router.get('/health', (req, res) => {
  const stateService = tryGetStateService();
  const services = {
    anchor: !!stateService?.stateData?.anchor,
    navigation: !!stateService?.stateData?.navigation,
    signalk: !!stateService?.isInitialized
  };

  const allHealthy = stateService && Object.values(services).every(Boolean);
  const status = stateService ? (allHealthy ? 'operational' : 'degraded') : 'unavailable';

  res.status(allHealthy ? 200 : 503).json({
    status,
    services,
    timestamp: new Date().toISOString(),
    version: process.env.APP_VERSION || '1.0.0'
  });
});

// ======================================
// Debug Endpoints
// ======================================
router.get('/debug/signalk', (req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(403).json({ error: 'Debug endpoint disabled in production' });
  }
  const stateService = tryGetStateService();
  if (!stateService) {
    return respondStateUnavailable(res);
  }
  const skData = stateService.getSnapshot ? stateService.getSnapshot() : stateService.stateData;
  res.json({
    signalkConnected: !!stateService.isInitialized,
    lastUpdate: skData?.meta?.lastUpdated,
    position: skData?.navigation?.position
  });
});

// ======================================
// Anchor Management Endpoints
// ======================================
router.get('/anchor', getAnchorState);
router.post('/anchor/drop', validate(anchorPositionSchema), setAnchorPosition);
router.put('/anchor/rode', updateRodeLength);
router.get('/anchor/history', getAnchorHistory);
router.get('/anchor/status', getAnchorStatus);

// ======================================
// Navigation Data Endpoints
// ======================================
router.get('/navigation', getNavigationSnapshot);
router.get('/navigation/position', getCurrentPosition);
router.get('/navigation/heading', getCurrentHeading);
router.get('/navigation/speed', getCurrentSpeed);
router.get('/navigation/batteries', getBatteryStatus);
router.get('/navigation/tanks', getTankLevels);
router.get('/navigation/status', getNavigationStatus);

// ======================================
// Position Data Endpoints (legacy)
// ======================================
router.get('/position', (req, res) => {
  const stateService = tryGetStateService();
  if (!stateService) {
    return respondStateUnavailable(res);
  }
  res.json(stateService.stateData?.navigation?.position || {});
});
router.get('/position/raw', (req, res) => {
  const stateService = tryGetStateService();
  if (!stateService) {
    return respondStateUnavailable(res);
  }
  res.json(stateService.stateData?.navigation?.position || {});
});

// ======================================
// Future Endpoints
// ======================================
// router.ws('/navigation/stream', subscribeNavigationUpdates);
// router.get('/signalk/*', proxySignalKRequest);
// router.ws('/signalk/stream', handleSignalKWebSocket);

export default router;