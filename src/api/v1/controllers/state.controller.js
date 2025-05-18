// src/server/api/v1/controllers/state.controller.js
import { stateService } from '../../../state/StateService.js';

// ========== ANCHOR ENDPOINTS ==========
export const getAnchorState = (req, res) => {
  const anchor = stateService.stateData.anchor || {};
  res.json({
    status: 'success',
    data: {
      anchorDropLocation: anchor.anchorDropLocation,
      anchorLocation: anchor.anchorLocation,
      rode: anchor.rode,
      dragging: anchor.dragging,
      anchorDeployed: anchor.anchorDeployed,
      criticalRange: anchor.criticalRange,
    }
  });
};

export const setAnchorPosition = (req, res) => {
  try {
    const { latitude, longitude, time } = req.body;
    if (!stateService.stateData.anchor) stateService.stateData.anchor = {};
    stateService.stateData.anchor.anchorDropLocation = {
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      time: time ?? Date.now(),
      distanceFromCurrentLocation: 0,
      distanceFromDropLocation: 0,
      originalBearing: 0,
    };
    res.status(201).json({
      status: 'success',
      data: stateService.stateData.anchor.anchorDropLocation
    });
  } catch (err) {
    res.status(400).json({
      status: 'error',
      error: 'Failed to set anchor position',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

export const updateRodeLength = (req, res) => {
  try {
    const { amount, units } = req.body;
    if (!stateService.stateData.anchor) stateService.stateData.anchor = {};
    stateService.stateData.anchor.rode = {
      amount: amount ?? 0,
      units: units ?? 'm',
    };
    res.json({
      status: 'success',
      data: stateService.stateData.anchor.rode
    });
  } catch (err) {
    res.status(400).json({
      status: 'error',
      error: 'Failed to update rode length',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

export const getAnchorHistory = (req, res) => {
  res.json({
    status: 'success',
    data: stateService.stateData.anchor?.history || []
  });
};

export const getAnchorStatus = (req, res) => {
  const anchor = stateService.stateData.anchor || {};
  res.json({
    status: 'success',
    data: {
      anchorDeployed: anchor.anchorDeployed,
      dragging: anchor.dragging,
      criticalRange: anchor.criticalRange,
    }
  });
};

// ========== NAVIGATION ENDPOINTS ==========
export const getNavigationSnapshot = (req, res) => {
  res.json({
    status: 'success',
    data: stateService.stateData.navigation || {}
  });
};

export const getCurrentPosition = (req, res) => {
  const position = stateService.stateData.navigation?.position || {};
  if (!position.latitude || !position.longitude) {
    return res.status(503).json({
      status: 'unavailable',
      error: 'Position data not available',
      lastUpdated: position.timestamp
    });
  }
  res.json({
    status: 'success',
    data: position
  });
};

export const getCurrentHeading = (req, res) => {
  res.json({
    status: 'success',
    data: { heading: stateService.stateData.navigation?.heading }
  });
};

export const getCurrentSpeed = (req, res) => {
  res.json({
    status: 'success',
    data: { speed: stateService.stateData.navigation?.speed }
  });
};

export const getBatteryStatus = (req, res) => {
  res.json({
    status: 'success',
    data: stateService.stateData.navigation?.batteries || {}
  });
};

export const getTankLevels = (req, res) => {
  res.json({
    status: 'success',
    data: stateService.stateData.navigation?.tanks || {}
  });
};

export const getNavigationStatus = (req, res) => {
  res.json({
    status: 'success',
    data: { status: stateService.stateData.navigation?.status }
  });
};

// ========== SIGNALK/LEGACY ==========
export const getSignalKPosition = (req, res) => {
  const position = stateService.stateData.navigation?.position;
  if (!position?.latitude || !position?.longitude) {
    return res.status(503).json({
      error: 'SignalK position not available',
      source: stateService.isInitialized ? 'connected' : 'disconnected'
    });
  }
  res.json(position);
};
