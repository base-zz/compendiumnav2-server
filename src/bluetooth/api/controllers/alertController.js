const express = require('express');
const router = express.Router();

class AlertController {
  constructor(alertManager) {
    this.alertManager = alertManager;
    this.router = router;
    this.initializeRoutes();
  }

  initializeRoutes() {
    // Get all alerts with filtering
    this.router.get('/', this.getAlerts.bind(this));
    
    // Get a single alert by ID
    this.router.get('/:id', this.getAlert.bind(this));
    
    // Acknowledge an alert
    this.router.post('/:id/acknowledge', this.acknowledgeAlert.bind(this));
    
    // Delete an alert
    this.router.delete('/:id', this.deleteAlert.bind(this));
    
    // Get alert statistics
    this.router.get('/stats', this.getAlertStats.bind(this));
    
    // Get unacknowledged alerts
    this.router.get('/unacknowledged', this.getUnacknowledgedAlerts.bind(this));
  }

  async getAlerts(req, res, next) {
    try {
      const {
        deviceId,
        type,
        severity,
        acknowledged,
        startDate,
        endDate = new Date().toISOString(),
        limit = 50,
        skip = 0
      } = req.query;

      const options = {
        deviceId,
        type,
        severity,
        acknowledged: acknowledged ? acknowledged === 'true' : undefined,
        startDate,
        endDate,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10)
      };

      const result = await this.alertManager.getAlerts(options);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  async getAlert(req, res, next) {
    try {
      const { id } = req.params;
      const alert = await this.alertManager.storage.getAlert(id);
      
      if (!alert) {
        return res.status(404).json({ error: 'Alert not found' });
      }
      
      res.json(alert);
    } catch (error) {
      next(error);
    }
  }

  async acknowledgeAlert(req, res, next) {
    try {
      const { id } = req.params;
      const { userId = 'system' } = req.body;
      
      const alert = await this.alertManager.acknowledgeAlert(id, userId);
      
      if (!alert) {
        return res.status(404).json({ error: 'Alert not found' });
      }
      
      res.json(alert);
    } catch (error) {
      next(error);
    }
  }

  async deleteAlert(req, res, next) {
    try {
      const { id } = req.params;
      await this.alertManager.storage.deleteAlert(id);
      res.status(204).send();
    } catch (error) {
      if (error.status === 404) {
        return res.status(404).json({ error: 'Alert not found' });
      }
      next(error);
    }
  }

  
  async getAlertStats(req, res, next) {
    try {
      const { startDate, endDate = new Date().toISOString() } = req.query;
      
      const stats = await this.alertManager.getAlertStats({
        startDate,
        endDate
      });
      
      res.json(stats);
    } catch (error) {
      next(error);
    }
  }
  
  async getUnacknowledgedAlerts(req, res, next) {
    try {
      const { limit = 50 } = req.query;
      const result = await this.alertManager.getUnacknowledgedAlerts(parseInt(limit, 10));
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
}

module.exports = AlertController;
