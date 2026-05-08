/**
 * Comprehensive tests for AlertService
 * Tests alert creation, resolution, and action processing
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { AlertService } from '../../../src/services/AlertService.js';

describe('AlertService', () => {
  let service;
  let mockStateManager;
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    mockStateManager = {
      appState: {
        alerts: {
          active: [],
          resolved: []
        }
      }
    };
    service = new AlertService(mockStateManager);
    sandbox.stub(console, 'error');
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('Constructor', () => {
    it('should initialize with stateManager', () => {
      expect(service.stateManager).to.equal(mockStateManager);
    });
  });

  describe('_ensureAlertsStructure()', () => {
    it('should create alerts structure if missing', () => {
      delete mockStateManager.appState.alerts;
      
      service._ensureAlertsStructure();
      
      expect(mockStateManager.appState.alerts).to.exist;
      expect(mockStateManager.appState.alerts.active).to.be.an('array');
      expect(mockStateManager.appState.alerts.resolved).to.be.an('array');
    });

    it('should create active array if missing', () => {
      mockStateManager.appState.alerts = { resolved: [] };
      
      service._ensureAlertsStructure();
      
      expect(mockStateManager.appState.alerts.active).to.be.an('array');
    });

    it('should create resolved array if missing', () => {
      mockStateManager.appState.alerts = { active: [] };
      
      service._ensureAlertsStructure();
      
      expect(mockStateManager.appState.alerts.resolved).to.be.an('array');
    });

    it('should not modify existing structure', () => {
      mockStateManager.appState.alerts = {
        active: [{ id: '1' }],
        resolved: [{ id: '2' }]
      };
      
      service._ensureAlertsStructure();
      
      expect(mockStateManager.appState.alerts.active).to.have.lengthOf(1);
      expect(mockStateManager.appState.alerts.resolved).to.have.lengthOf(1);
    });
  });

  describe('createAlert()', () => {
    it('should create an alert with valid data', () => {
      const alertData = {
        trigger: 'anchor_dragging',
        type: 'anchor',
        label: 'Anchor Dragging',
        message: 'Anchor is dragging'
      };
      
      const alert = service.createAlert(alertData);
      
      expect(alert).to.exist;
      expect(alert.id).to.exist;
      expect(alert.trigger).to.equal('anchor_dragging');
      expect(alert.type).to.equal('anchor');
      expect(alert.label).to.equal('Anchor Dragging');
      expect(alert.message).to.equal('Anchor is dragging');
      expect(alert.status).to.equal('active');
      expect(alert.acknowledged).to.be.false;
    });

    it('should use default values for optional fields', () => {
      const alertData = {
        trigger: 'test_trigger'
      };
      
      const alert = service.createAlert(alertData);
      
      expect(alert.type).to.equal('system');
      expect(alert.category).to.equal('anchor');
      expect(alert.source).to.equal('anchor_monitor');
      expect(alert.level).to.equal('warning');
      expect(alert.label).to.equal('Alert');
      expect(alert.message).to.equal('Alert triggered');
      expect(alert.phoneNotification).to.be.true;
      expect(alert.sticky).to.be.true;
      expect(alert.autoResolvable).to.be.true;
    });

    it('should add alert to active alerts', () => {
      const alertData = { trigger: 'test' };
      
      service.createAlert(alertData);
      
      expect(mockStateManager.appState.alerts.active).to.have.lengthOf(1);
    });

    it('should return null for invalid alert data', () => {
      const consoleWarnStub = sandbox.stub(console, 'warn');
      
      const result1 = service.createAlert(null);
      const result2 = service.createAlert({});
      const result3 = service.createAlert({ type: 'test' });
      
      expect(result1).to.be.null;
      expect(result2).to.be.null;
      expect(result3).to.be.null;
      expect(consoleWarnStub.calledThrice).to.be.true;
    });

    it('should generate unique ID for each alert', () => {
      const alert1 = service.createAlert({ trigger: 'test1' });
      const alert2 = service.createAlert({ trigger: 'test2' });
      
      expect(alert1.id).to.not.equal(alert2.id);
    });

    it('should include timestamp', () => {
      const alertData = { trigger: 'test' };
      const beforeTime = new Date();
      
      const alert = service.createAlert(alertData);
      const afterTime = new Date();
      
      const alertTime = new Date(alert.timestamp);
      expect(alertTime.getTime()).to.be.at.least(beforeTime.getTime());
      expect(alertTime.getTime()).to.be.at.most(afterTime.getTime());
    });

    it('should include custom data', () => {
      const customData = { distance: 100, units: 'm' };
      const alertData = { trigger: 'test', data: customData };
      
      const alert = service.createAlert(alertData);
      
      expect(alert.data).to.deep.equal(customData);
    });

    it('should include custom actions', () => {
      const customActions = ['acknowledge', 'mute', 'dismiss'];
      const alertData = { trigger: 'test', actions: customActions };
      
      const alert = service.createAlert(alertData);
      
      expect(alert.actions).to.deep.equal(customActions);
    });

    it('should handle phoneNotification override', () => {
      const alertData = { trigger: 'test', phoneNotification: false };
      
      const alert = service.createAlert(alertData);
      
      expect(alert.phoneNotification).to.be.false;
    });

    it('should handle sticky override', () => {
      const alertData = { trigger: 'test', sticky: false };
      
      const alert = service.createAlert(alertData);
      
      expect(alert.sticky).to.be.false;
    });

    it('should handle autoResolvable override', () => {
      const alertData = { trigger: 'test', autoResolvable: false };
      
      const alert = service.createAlert(alertData);
      
      expect(alert.autoResolvable).to.be.false;
    });
  });

  describe('resolveAlertsByTrigger()', () => {
    beforeEach(() => {
      mockStateManager.appState.alerts.active = [
        {
          id: '1',
          trigger: 'anchor_dragging',
          autoResolvable: true,
          acknowledged: false,
          status: 'active'
        },
        {
          id: '2',
          trigger: 'anchor_dragging',
          autoResolvable: true,
          acknowledged: false,
          status: 'active'
        },
        {
          id: '3',
          trigger: 'critical_range',
          autoResolvable: true,
          acknowledged: false,
          status: 'active'
        },
        {
          id: '4',
          trigger: 'anchor_dragging',
          autoResolvable: false,
          acknowledged: false,
          status: 'active'
        },
        {
          id: '5',
          trigger: 'anchor_dragging',
          autoResolvable: true,
          acknowledged: true,
          status: 'active'
        }
      ];
    });

    it('should resolve alerts matching trigger type', () => {
      const resolved = service.resolveAlertsByTrigger('anchor_dragging');
      
      expect(resolved).to.have.lengthOf(2);
      expect(resolved.every(a => a.trigger === 'anchor_dragging')).to.be.true;
    });

    it('should only resolve auto-resolvable alerts', () => {
      const resolved = service.resolveAlertsByTrigger('anchor_dragging');
      
      expect(resolved.every(a => a.autoResolvable === true)).to.be.true;
    });

    it('should only resolve unacknowledged alerts', () => {
      const resolved = service.resolveAlertsByTrigger('anchor_dragging');
      
      expect(resolved.every(a => a.acknowledged === false)).to.be.true;
    });

    it('should update alert status to resolved', () => {
      service.resolveAlertsByTrigger('anchor_dragging');
      
      const resolvedAlerts = mockStateManager.appState.alerts.resolved;
      expect(resolvedAlerts.every(a => a.status === 'resolved')).to.be.true;
    });

    it('should add resolvedAt timestamp', () => {
      const beforeTime = new Date();
      
      service.resolveAlertsByTrigger('anchor_dragging');
      
      const resolvedAlerts = mockStateManager.appState.alerts.resolved;
      const alertTime = new Date(resolvedAlerts[0].resolvedAt);
      expect(alertTime.getTime()).to.be.at.least(beforeTime.getTime());
    });

    it('should include resolutionData', () => {
      const resolutionData = { distance: 50, units: 'm' };
      
      service.resolveAlertsByTrigger('anchor_dragging', resolutionData);
      
      const resolvedAlerts = mockStateManager.appState.alerts.resolved;
      expect(resolvedAlerts[0].resolutionData).to.deep.include(resolutionData);
      expect(resolvedAlerts[0].resolutionData.autoResolved).to.be.true;
    });

    it('should move alerts from active to resolved', () => {
      const initialActiveCount = mockStateManager.appState.alerts.active.length;

      service.resolveAlertsByTrigger('anchor_dragging');

      // 2 alerts resolved, 1 resolution notification added
      expect(mockStateManager.appState.alerts.active.length).to.equal(initialActiveCount - 2 + 1);
      expect(mockStateManager.appState.alerts.resolved.length).to.equal(2);
    });

    it('should return empty array if no alerts match', () => {
      const resolved = service.resolveAlertsByTrigger('non_existent');
      
      expect(resolved).to.be.an('array').that.is.empty;
    });

    it('should handle empty active alerts', () => {
      mockStateManager.appState.alerts.active = [];
      
      const resolved = service.resolveAlertsByTrigger('anchor_dragging');
      
      expect(resolved).to.be.an('array').that.is.empty;
    });

    it('should create resolution notification', () => {
      service.resolveAlertsByTrigger('anchor_dragging');

      // After resolving 2 alerts, 1 resolution notification is added
      expect(mockStateManager.appState.alerts.active.length).to.equal(4);
      expect(mockStateManager.appState.alerts.active[3].trigger).to.equal('anchor_dragging_resolved');
    });

    it('should not create notification if no alerts resolved', () => {
      mockStateManager.appState.alerts.active = [];
      
      service.resolveAlertsByTrigger('anchor_dragging');
      
      expect(mockStateManager.appState.alerts.active.length).to.equal(0);
    });
  });

  describe('_createResolutionNotification()', () => {
    it('should create notification for critical_range trigger', () => {
      mockStateManager.appState.alerts.resolved = [
        {
          trigger: 'critical_range',
          category: 'anchor',
          source: 'anchor_monitor'
        }
      ];
      
      service._createResolutionNotification('critical_range', { distance: 50, units: 'm' });
      
      expect(mockStateManager.appState.alerts.active).to.have.lengthOf(1);
      const notification = mockStateManager.appState.alerts.active[0];
      expect(notification.trigger).to.equal('critical_range_resolved');
      expect(notification.message).to.include('returned within critical range');
    });

    it('should create notification for anchor_dragging trigger', () => {
      mockStateManager.appState.alerts.resolved = [
        {
          trigger: 'anchor_dragging',
          category: 'anchor',
          source: 'anchor_monitor'
        }
      ];
      
      service._createResolutionNotification('anchor_dragging', { distance: 50, units: 'm' });
      
      const notification = mockStateManager.appState.alerts.active[0];
      expect(notification.message).to.include('no longer dragging');
    });

    it('should create notification for ais_proximity trigger', () => {
      mockStateManager.appState.alerts.resolved = [
        {
          trigger: 'ais_proximity',
          category: 'ais',
          source: 'ais_monitor'
        }
      ];
      
      service._createResolutionNotification('ais_proximity', { warningRadius: 500, units: 'm' });
      
      const notification = mockStateManager.appState.alerts.active[0];
      expect(notification.message).to.include('No vessels detected');
    });

    it('should create generic notification for unknown trigger', () => {
      mockStateManager.appState.alerts.resolved = [
        {
          trigger: 'custom_trigger',
          category: 'system',
          source: 'system'
        }
      ];
      
      service._createResolutionNotification('custom_trigger', {});
      
      const notification = mockStateManager.appState.alerts.active[0];
      expect(notification.message).to.include('custom_trigger condition has been resolved');
    });

    it('should return early if no resolved alert found', () => {
      mockStateManager.appState.alerts.resolved = [];
      
      service._createResolutionNotification('anchor_dragging', {});
      
      expect(mockStateManager.appState.alerts.active.length).to.equal(0);
    });

    it('should set notification properties correctly', () => {
      mockStateManager.appState.alerts.resolved = [
        {
          trigger: 'anchor_dragging',
          category: 'anchor',
          source: 'anchor_monitor'
        }
      ];
      
      service._createResolutionNotification('anchor_dragging', {});
      
      const notification = mockStateManager.appState.alerts.active[0];
      expect(notification.type).to.equal('system');
      expect(notification.level).to.equal('info');
      expect(notification.label).to.equal('Condition Resolved');
      expect(notification.autoResolvable).to.be.true;
      expect(notification.autoExpire).to.be.true;
      expect(notification.expiresIn).to.equal(60000);
    });

    it('should copy category and source from base alert', () => {
      mockStateManager.appState.alerts.resolved = [
        {
          trigger: 'anchor_dragging',
          category: 'anchor',
          source: 'custom_source'
        }
      ];
      
      service._createResolutionNotification('anchor_dragging', {});
      
      const notification = mockStateManager.appState.alerts.active[0];
      expect(notification.category).to.equal('anchor');
      expect(notification.source).to.equal('custom_source');
    });
  });

  describe('processAlertActions()', () => {
    it('should return false for null actions', () => {
      const result = service.processAlertActions(null);
      expect(result).to.be.false;
    });

    it('should return false for empty actions array', () => {
      const result = service.processAlertActions([]);
      expect(result).to.be.false;
    });

    it('should process CREATE_ALERT action', () => {
      const actions = [
        {
          type: 'CREATE_ALERT',
          alertData: { trigger: 'test', label: 'Test Alert' }
        }
      ];
      
      const result = service.processAlertActions(actions);
      
      expect(result).to.be.true;
      expect(mockStateManager.appState.alerts.active).to.have.lengthOf(1);
    });

    it('should process RESOLVE_ALERTS action', () => {
      mockStateManager.appState.alerts.active = [
        {
          id: '1',
          trigger: 'anchor_dragging',
          autoResolvable: true,
          acknowledged: false,
          status: 'active'
        }
      ];

      const actions = [
        {
          type: 'RESOLVE_ALERTS',
          trigger: 'anchor_dragging'
        }
      ];

      const result = service.processAlertActions(actions);

      expect(result).to.be.true;
      // 1 alert resolved, 1 resolution notification added
      expect(mockStateManager.appState.alerts.active).to.have.lengthOf(1);
      expect(mockStateManager.appState.alerts.active[0].trigger).to.equal('anchor_dragging_resolved');
    });

    it('should handle function alertData', () => {
      const actions = [
        {
          type: 'CREATE_ALERT',
          alertData: (state) => ({
            trigger: 'test',
            label: `Alert for ${state.alerts.active.length}`
          })
        }
      ];
      
      const result = service.processAlertActions(actions);
      
      expect(result).to.be.true;
      expect(mockStateManager.appState.alerts.active[0].label).to.equal('Alert for 0');
    });

    it('should handle function resolutionData', () => {
      mockStateManager.appState.alerts.active = [
        {
          id: '1',
          trigger: 'anchor_dragging',
          autoResolvable: true,
          acknowledged: false,
          status: 'active'
        }
      ];
      
      const actions = [
        {
          type: 'RESOLVE_ALERTS',
          trigger: 'anchor_dragging',
          resolutionData: (state) => ({ count: state.alerts.active.length })
        }
      ];
      
      const result = service.processAlertActions(actions);
      
      expect(result).to.be.true;
      expect(mockStateManager.appState.alerts.resolved[0].resolutionData.count).to.equal(1);
    });

    it('should process multiple actions', () => {
      const actions = [
        {
          type: 'CREATE_ALERT',
          alertData: { trigger: 'test1' }
        },
        {
          type: 'CREATE_ALERT',
          alertData: { trigger: 'test2' }
        }
      ];
      
      const result = service.processAlertActions(actions);
      
      expect(result).to.be.true;
      expect(mockStateManager.appState.alerts.active).to.have.lengthOf(2);
    });

    it('should skip actions without alertData', () => {
      const actions = [
        {
          type: 'CREATE_ALERT'
        }
      ];
      
      const result = service.processAlertActions(actions);
      
      expect(result).to.be.false;
    });

    it('should skip unknown action types', () => {
      const actions = [
        {
          type: 'UNKNOWN_ACTION',
          data: {}
        }
      ];
      
      const result = service.processAlertActions(actions);
      
      expect(result).to.be.false;
    });

    it('should handle null alertData from function', () => {
      const actions = [
        {
          type: 'CREATE_ALERT',
          alertData: () => null
        }
      ];
      
      const result = service.processAlertActions(actions);
      
      expect(result).to.be.false;
    });

    it('should return true if any action causes state change', () => {
      const actions = [
        {
          type: 'CREATE_ALERT',
          alertData: { trigger: 'test' }
        },
        {
          type: 'UNKNOWN_ACTION'
        }
      ];
      
      const result = service.processAlertActions(actions);
      
      expect(result).to.be.true;
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing stateManager gracefully', () => {
      const serviceNoManager = new AlertService(null);
      
      const alertData = { trigger: 'test' };
      
      expect(() => serviceNoManager.createAlert(alertData)).to.throw();
    });

    it('should handle stateManager without appState', () => {
      const serviceNoState = new AlertService({});
      
      const alertData = { trigger: 'test' };
      
      expect(() => serviceNoState.createAlert(alertData)).to.throw();
    });

    it('should handle concurrent alert creation', () => {
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(Promise.resolve().then(() => 
          service.createAlert({ trigger: `test${i}` })
        ));
      }
      
      return Promise.all(promises).then((alerts) => {
        expect(alerts.every(a => a !== null)).to.be.true;
        expect(mockStateManager.appState.alerts.active).to.have.lengthOf(10);
      });
    });

    it('should handle alert with all optional fields', () => {
      const alertData = {
        trigger: 'test',
        type: 'custom',
        category: 'custom',
        source: 'custom',
        level: 'critical',
        label: 'Custom Alert',
        message: 'Custom message',
        data: { key: 'value' },
        actions: ['custom_action'],
        phoneNotification: false,
        sticky: false,
        autoResolvable: false
      };
      
      const alert = service.createAlert(alertData);
      
      expect(alert.type).to.equal('custom');
      expect(alert.category).to.equal('custom');
      expect(alert.source).to.equal('custom');
      expect(alert.level).to.equal('critical');
      expect(alert.phoneNotification).to.be.false;
      expect(alert.sticky).to.be.false;
      expect(alert.autoResolvable).to.be.false;
    });

    it('should handle resolution with complex data', () => {
      mockStateManager.appState.alerts.active = [
        {
          id: '1',
          trigger: 'anchor_dragging',
          autoResolvable: true,
          acknowledged: false,
          status: 'active'
        }
      ];
      
      const complexData = {
        distance: 123.45,
        units: 'm',
        position: { lat: 34.5, lon: -76.6 },
        timestamp: new Date().toISOString(),
        metadata: { key1: 'value1', key2: 'value2' }
      };
      
      service.resolveAlertsByTrigger('anchor_dragging', complexData);
      
      expect(mockStateManager.appState.alerts.resolved[0].resolutionData).to.deep.include(complexData);
    });
  });
});
