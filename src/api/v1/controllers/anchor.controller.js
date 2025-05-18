// DEPRECATED: All anchor logic migrated to state.controller.js
 * @api {get} /anchor Get Anchor State
 * @apiName GetAnchorState
 * @apiGroup Anchor
 * @apiDescription Returns complete anchor system state
 */
export function getAnchorState(req, res) {
  try {
    const anchorData = stateService.stateData.anchor;
    res.json({
      status: 'success',
      data: {
        deployed: anchorData.deployed,
        position: anchorData.position,
        currentRode: anchorData.currentRode,
        dragging: anchorData.dragging,
        meta: anchorData.meta
      }
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: 'Failed to retrieve anchor state',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

/**
 * @api {post} /anchor/drop Set Anchor Position
 * @apiName SetAnchorPosition
 * @apiGroup Anchor
 * @apiDescription Records anchor drop location
 * @apiParam {Number} lat Latitude in decimal degrees
 * @apiParam {Number} lon Longitude in decimal degrees
 */
export const setAnchorPosition = async (req, res) => {
  try {
    const { lat, lon, depth } = req.body;
    // If you have a stateService method, use it here. Otherwise, update directly:
    if (!stateService.stateData.anchor) stateService.stateData.anchor = {};
    stateService.stateData.anchor.position = { lat, lon };
    if (depth !== undefined) {
      stateService.stateData.anchor.depth = depth;
    }
    stateService.stateData.anchor.lastDropTimestamp = new Date().toISOString();
    res.status(201).json({
      status: 'success',
      data: {
        position: { lat, lon },
        depth: stateService.stateData.anchor.depth,
        timestamp: stateService.stateData.anchor.lastDropTimestamp
      }
    });
  } catch (err) {
    res.status(400).json({
      status: 'error',
      error: 'Failed to set anchor position',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

/**
 * @api {put} /anchor/rode Update Rode Length
 * @apiName UpdateRodeLength
 * @apiGroup Anchor
 * @apiDescription Updates anchor rode length
 * @apiParam {Number} length Rode length
 * @apiParam {String="feet","meters"} [units=feet] Measurement units
 */
export const updateRodeLength = async (req, res) => {
  try {
    const { length, units } = req.body;
    anchorService.setRodeLength(length, units);
    
    res.json({
      status: 'success',
      data: {
        length,
        units: units || 'feet',
        updatedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    res.status(400).json({
      status: 'error',
      error: 'Failed to update rode length',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

/**
 * @api {get} /anchor/history Get Anchor History
 * @apiName GetAnchorHistory
 * @apiGroup Anchor
 * @apiDescription Returns anchor deployment history
 */
export const getAnchorHistory = async (req, res) => {
  try {
    const history = anchorService.getAnchorHistory();
    res.json({
      status: 'success',
      data: history,
      meta: {
        count: history.length,
        lastDeployment: history.length > 0 
          ? history[history.length - 1].timestamp 
          : null
      }
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: 'Failed to retrieve anchor history',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

/**
 * @api {get} /anchor/status Get Anchor Status
 * @apiName GetAnchorStatus
 * @apiGroup Anchor
 * @apiDescription Returns current anchor deployment and dragging status
 */
export const getAnchorStatus = async (req, res) => {
  try {
    const status = anchorService.getAnchorStatus();
    res.json({
      status: 'success',
      data: status,
      meta: {
        lastUpdated: anchorService.getSnapshot().meta.lastUpdated
      }
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: 'Failed to retrieve anchor status',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};