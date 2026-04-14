import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import storageService from "../../bluetooth/services/storage/storageService.js";

console.log('[ROUTES] routes import module loaded');

function extractBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') {
    return null;
  }

  const trimmed = authorizationHeader.trim();
  if (!trimmed.startsWith('Bearer ')) {
    return null;
  }

  const token = trimmed.slice('Bearer '.length).trim();
  if (!token) {
    return null;
  }

  return token;
}

function verifyJwtToken(token) {
  if (typeof token !== 'string') {
    return null;
  }

  const publicKey = process.env.ROUTE_IMPORT_JWT_PUBLIC_KEY;
  const sharedSecret = process.env.ROUTE_IMPORT_JWT_SECRET;

  if ((typeof publicKey !== 'string' || !publicKey.trim()) && (typeof sharedSecret !== 'string' || !sharedSecret.trim())) {
    return {
      ok: false,
      error: 'Route import auth is not configured. Set ROUTE_IMPORT_JWT_PUBLIC_KEY or ROUTE_IMPORT_JWT_SECRET.'
    };
  }

  try {
    if (typeof publicKey === 'string' && publicKey.trim()) {
      const verified = jwt.verify(token, publicKey, { algorithms: ['RS256'] });
      if (!verified || typeof verified !== 'object') {
        return { ok: false, error: 'Invalid bearer token payload' };
      }
      return { ok: true, payload: verified };
    }

    const verified = jwt.verify(token, sharedSecret, { algorithms: ['HS256'] });
    if (!verified || typeof verified !== 'object') {
      return { ok: false, error: 'Invalid bearer token payload' };
    }

    return { ok: true, payload: verified };
  } catch (error) {
    return { ok: false, error: 'Bearer token verification failed' };
  }
}

function extractUserIdFromTokenPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'sub') && typeof payload.sub === 'string' && payload.sub.trim()) {
    return payload.sub;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'userId') && typeof payload.userId === 'string' && payload.userId.trim()) {
    return payload.userId;
  }

  return null;
}

function isValidWaypoint(waypoint) {
  if (!waypoint || typeof waypoint !== 'object') {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(waypoint, 'lat') || !Object.prototype.hasOwnProperty.call(waypoint, 'lon')) {
    return false;
  }

  if (typeof waypoint.lat !== 'number' || typeof waypoint.lon !== 'number') {
    return false;
  }

  if (!Number.isFinite(waypoint.lat) || !Number.isFinite(waypoint.lon)) {
    return false;
  }

  if (waypoint.lat < -90 || waypoint.lat > 90) {
    return false;
  }

  if (waypoint.lon < -180 || waypoint.lon > 180) {
    return false;
  }

  return true;
}

function hasBasicGpxStructure(gpxData) {
  if (typeof gpxData !== 'string') {
    return false;
  }

  const trimmed = gpxData.trim();
  if (!trimmed) {
    return false;
  }

  const lower = trimmed.toLowerCase();
  const gpxOpenIndex = lower.indexOf('<gpx');
  const gpxCloseIndex = lower.lastIndexOf('</gpx>');

  if (gpxOpenIndex === -1 || gpxCloseIndex === -1) {
    return false;
  }

  if (gpxOpenIndex > gpxCloseIndex) {
    return false;
  }

  return true;
}

function parseConfiguredMaxGpxBytes() {
  const value = process.env.ROUTE_IMPORT_MAX_GPX_BYTES;
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

export function registerRouteImportRoutes(app) {
  // GET /api/routes - List all imported routes
  app.get('/api/routes', async (req, res) => {
    try {
      console.log('[ROUTES] GET /api/routes request received');
      
      if (!storageService.initialize) {
        console.log('[ROUTES] List rejected: storageService.initialize unavailable');
        return res.status(500).json({ success: false, error: 'Storage service not available' });
      }
      
      await storageService.initialize();
      console.log('[ROUTES] storageService initialized for route list');
      
      const importedRoutes = await storageService.getSetting('importedRoutes');
      const activeRouteId = await storageService.getSetting('activeRouteId');
      
      const routes = Array.isArray(importedRoutes) ? importedRoutes : [];
      
      return res.status(200).json({
        success: true,
        routes: routes.map(r => ({
          routeId: r.routeId,
          name: r.name,
          source: r.source,
          createdAt: r.createdAt,
          waypoints: r.waypoints?.length || 0,
          isActive: r.routeId === activeRouteId
        })),
        activeRouteId
      });
    } catch (error) {
      console.error('[ROUTES] Error listing routes:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to list routes'
      });
    }
  });

  // GET /api/routes/active - Get currently active route
  app.get('/api/routes/active', async (req, res) => {
    try {
      console.log('[ROUTES] GET /api/routes/active request received');
      
      if (!storageService.initialize) {
        console.log('[ROUTES] Get active rejected: storageService.initialize unavailable');
        return res.status(500).json({ success: false, error: 'Storage service not available' });
      }
      
      await storageService.initialize();
      
      const activeRouteId = await storageService.getSetting('activeRouteId');
      if (!activeRouteId) {
        return res.status(200).json({ success: true, activeRoute: null });
      }
      
      const importedRoutes = await storageService.getSetting('importedRoutes');
      const routes = Array.isArray(importedRoutes) ? importedRoutes : [];
      const activeRoute = routes.find(r => r.routeId === activeRouteId);
      
      if (!activeRoute) {
        return res.status(200).json({ success: true, activeRoute: null, activeRouteId });
      }
      
      return res.status(200).json({
        success: true,
        activeRoute: {
          routeId: activeRoute.routeId,
          name: activeRoute.name,
          source: activeRoute.source,
          createdAt: activeRoute.createdAt,
          waypoints: activeRoute.waypoints?.length || 0
        }
      });
    } catch (error) {
      console.error('[ROUTES] Error getting active route:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to get active route'
      });
    }
  });

  // PUT /api/routes/active - Set active route
  app.put('/api/routes/active', async (req, res) => {
    try {
      console.log('[ROUTES] PUT /api/routes/active request received');
      
      const { routeId } = req.body;
      if (!routeId) {
        console.log('[ROUTES] Set active rejected: routeId missing');
        return res.status(400).json({ success: false, error: 'routeId is required' });
      }
      
      if (!storageService.initialize) {
        console.log('[ROUTES] Set active rejected: storageService.initialize unavailable');
        return res.status(500).json({ success: false, error: 'Storage service not available' });
      }
      
      await storageService.initialize();
      
      // Verify route exists
      const importedRoutes = await storageService.getSetting('importedRoutes');
      const routes = Array.isArray(importedRoutes) ? importedRoutes : [];
      const route = routes.find(r => r.routeId === routeId);
      
      if (!route) {
        console.log('[ROUTES] Set active rejected: route not found');
        return res.status(404).json({ success: false, error: 'Route not found' });
      }
      
      // Set active route
      const persisted = await storageService.setSetting('activeRouteId', routeId);
      if (!persisted) {
        console.log('[ROUTES] Set active failed: unable to persist');
        return res.status(500).json({ success: false, error: 'Failed to set active route' });
      }
      
      console.log(`[ROUTES] Set active route: ${routeId} (${route.name})`);
      
      return res.status(200).json({
        success: true,
        action: 'route:activated',
        routeId,
        routeName: route.name
      });
    } catch (error) {
      console.error('[ROUTES] Error setting active route:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to set active route'
      });
    }
  });

  // DELETE /api/routes/:routeId - Delete a route
  app.delete('/api/routes/:routeId', async (req, res) => {
    try {
      const { routeId } = req.params;
      console.log(`[ROUTES] DELETE /api/routes/${routeId} request received`);
      
      if (!routeId) {
        console.log('[ROUTES] Delete rejected: routeId missing');
        return res.status(400).json({ success: false, error: 'routeId is required' });
      }
      
      if (!storageService.initialize) {
        console.log('[ROUTES] Delete rejected: storageService.initialize unavailable');
        return res.status(500).json({ success: false, error: 'Storage service not available' });
      }
      
      await storageService.initialize();
      
      // Get current routes
      const importedRoutes = await storageService.getSetting('importedRoutes');
      const routes = Array.isArray(importedRoutes) ? importedRoutes : [];
      
      // Find and remove route
      const routeIndex = routes.findIndex(r => r.routeId === routeId);
      if (routeIndex === -1) {
        console.log('[ROUTES] Delete rejected: route not found');
        return res.status(404).json({ success: false, error: 'Route not found' });
      }
      
      const deletedRoute = routes[routeIndex];
      routes.splice(routeIndex, 1);
      
      // Persist updated routes
      const persisted = await storageService.setSetting('importedRoutes', routes);
      if (!persisted) {
        console.log('[ROUTES] Delete failed: unable to persist');
        return res.status(500).json({ success: false, error: 'Failed to delete route' });
      }
      
      // If deleted route was active, clear activeRouteId
      const activeRouteId = await storageService.getSetting('activeRouteId');
      if (activeRouteId === routeId) {
        await storageService.setSetting('activeRouteId', null);
        console.log(`[ROUTES] Cleared activeRouteId (deleted route was active)`);
      }
      
      console.log(`[ROUTES] Deleted route: ${routeId} (${deletedRoute.name})`);
      
      return res.status(200).json({
        success: true,
        action: 'route:deleted',
        routeId,
        routeName: deletedRoute.name
      });
    } catch (error) {
      console.error('[ROUTES] Error deleting route:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to delete route'
      });
    }
  });

  app.post('/api/routes/import', async (req, res) => {
    try {
      console.log('[ROUTES] /api/routes/import request received');

      const token = extractBearerToken(req.headers.authorization);
      console.log(`[ROUTES] Auth header present=${!!req.headers.authorization}, bearer parsed=${!!token}`);
      if (!token) {
        console.log('[ROUTES] Import rejected: missing bearer token');
        return res.status(401).json({ success: false, action: 'auth:required', error: 'Authorization: Bearer token is required' });
      }

      const verifiedToken = verifyJwtToken(token);
      if (!verifiedToken || verifiedToken.ok !== true) {
        console.log(`[ROUTES] Import rejected: token verification failed (${verifiedToken && verifiedToken.error ? verifiedToken.error : 'unknown'})`);
        return res.status(401).json({
          success: false,
          action: 'auth:invalid',
          error: verifiedToken && verifiedToken.error ? verifiedToken.error : 'Invalid bearer token format'
        });
      }
      console.log('[ROUTES] Token verified successfully');

      const importedBy = extractUserIdFromTokenPayload(verifiedToken.payload);
      if (!importedBy) {
        console.log('[ROUTES] Import rejected: token payload missing sub/userId');
        return res.status(401).json({
          success: false,
          action: 'auth:invalid-payload',
          error: 'Bearer token payload must include sub or userId'
        });
      }
      console.log(`[ROUTES] Token payload accepted for importedBy=${importedBy}`);

      const maxGpxBytes = parseConfiguredMaxGpxBytes();
      if (!maxGpxBytes) {
        console.log('[ROUTES] Import rejected: ROUTE_IMPORT_MAX_GPX_BYTES missing/invalid');
        return res.status(500).json({
          success: false,
          action: 'config:error',
          error: 'ROUTE_IMPORT_MAX_GPX_BYTES is missing or invalid. Please set it in server environment.'
        });
      }
      console.log(`[ROUTES] GPX max size configured: ${maxGpxBytes} bytes`);

      const body = req.body;
      if (!body || typeof body !== 'object') {
        console.log('[ROUTES] Import rejected: request body missing/invalid');
        return res.status(400).json({ success: false, action: 'validation:error', error: 'Request body is required' });
      }

      if (!Object.prototype.hasOwnProperty.call(body, 'gpxData') || typeof body.gpxData !== 'string' || !body.gpxData.trim()) {
        console.log('[ROUTES] Import rejected: gpxData missing/empty');
        return res.status(400).json({ success: false, action: 'validation:error', error: 'gpxData is required and must be a non-empty string' });
      }
      console.log('[ROUTES] gpxData present');

      if (!hasBasicGpxStructure(body.gpxData)) {
        console.log('[ROUTES] Import rejected: malformed GPX structure');
        return res.status(400).json({ success: false, action: 'validation:error', error: 'Malformed GPX/XML payload' });
      }
      console.log('[ROUTES] GPX structure validation passed');

      const gpxByteLength = Buffer.byteLength(body.gpxData, 'utf8');
      console.log(`[ROUTES] gpxData byte size=${gpxByteLength}`);
      if (gpxByteLength > maxGpxBytes) {
        console.log('[ROUTES] Import rejected: GPX payload too large');
        return res.status(413).json({
          success: false,
          action: 'validation:payload-too-large',
          error: `gpxData exceeds max size of ${maxGpxBytes} bytes`
        });
      }

      if (!Object.prototype.hasOwnProperty.call(body, 'waypoints') || !Array.isArray(body.waypoints)) {
        console.log('[ROUTES] Import rejected: waypoints missing/not-array');
        return res.status(400).json({ success: false, action: 'validation:error', error: 'waypoints is required and must be an array' });
      }
      console.log(`[ROUTES] waypoints count=${body.waypoints.length}`);

      for (let i = 0; i < body.waypoints.length; i += 1) {
        if (!isValidWaypoint(body.waypoints[i])) {
          console.log(`[ROUTES] Import rejected: invalid waypoint at index=${i}`);
          return res.status(400).json({
            success: false,
            action: 'validation:error',
            error: `waypoints[${i}] must include numeric lat and lon within valid range`
          });
        }
      }
      console.log('[ROUTES] Waypoint validation passed');

      if (!Object.prototype.hasOwnProperty.call(body, 'name') || typeof body.name !== 'string' || !body.name.trim()) {
        console.log('[ROUTES] Import rejected: name missing/empty');
        return res.status(400).json({ success: false, action: 'validation:error', error: 'name is required and must be a non-empty string' });
      }

      if (!Object.prototype.hasOwnProperty.call(body, 'source') || typeof body.source !== 'string' || !body.source.trim()) {
        console.log('[ROUTES] Import rejected: source missing/empty');
        return res.status(400).json({ success: false, action: 'validation:error', error: 'source is required and must be a non-empty string' });
      }
      console.log(`[ROUTES] Route metadata accepted: name="${body.name}", source="${body.source}"`);

      if (Object.prototype.hasOwnProperty.call(body, 'note') && body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
        console.log('[ROUTES] Import rejected: note has invalid type');
        return res.status(400).json({ success: false, action: 'validation:error', error: 'note must be a string when provided' });
      }

      if (typeof storageService.initialize !== 'function') {
        console.log('[ROUTES] Import failed: storageService.initialize unavailable');
        return res.status(500).json({ success: false, action: 'storage:unavailable', error: 'storageService is not available' });
      }

      await storageService.initialize();
      console.log('[ROUTES] storageService initialized for route import');

      const routeId = crypto.randomUUID();
      const nowIso = new Date().toISOString();

      const routeRecord = {
        routeId,
        name: body.name,
        gpxData: body.gpxData,
        waypoints: body.waypoints,
        source: body.source,
        createdAt: nowIso,
        importedBy
      };

      if (Object.prototype.hasOwnProperty.call(body, 'note')) {
        routeRecord.note = body.note;
      }

      const existingRoutes = await storageService.getSetting('importedRoutes');
      let routesToPersist;

      if (Array.isArray(existingRoutes)) {
        routesToPersist = [...existingRoutes, routeRecord];
      } else {
        routesToPersist = [routeRecord];
      }

      const persisted = await storageService.setSetting('importedRoutes', routesToPersist);
      if (!persisted) {
        console.log('[ROUTES] Import failed: unable to persist route in storage');
        return res.status(500).json({ success: false, action: 'storage:write-failed', error: 'Failed to store imported route' });
      }

      console.log(`[ROUTES] Imported route ${routeId} from source=${body.source}, waypoints=${body.waypoints.length}, totalStored=${routesToPersist.length}`);

      return res.status(201).json({
        success: true,
        action: 'route:imported',
        routeId
      });
    } catch (error) {
      console.error('[ROUTES] Error importing route:', error);
      return res.status(500).json({
        success: false,
        action: 'route:import-failed',
        error: 'Failed to import route'
      });
    }
  });
}
