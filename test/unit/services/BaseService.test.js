/**
 * Comprehensive tests for BaseService
 * Tests the base service class that all services extend
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import BaseService from '../../../src/services/BaseService.js';

describe('BaseService', () => {
  let service;
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    service = new BaseService('test-service', 'base');
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('Constructor', () => {
    it('should initialize with correct default values', () => {
      expect(service.name).to.equal('test-service');
      expect(service.type).to.equal('base');
      expect(service.isRunning).to.be.false;
      expect(service.isReady).to.be.false;
      expect(service._dependencies).to.deep.equal([]);
      expect(service.dependencies).to.deep.equal({});
      expect(service.lastUpdated).to.be.null;
      expect(service.serviceManager).to.be.null;
    });

    it('should use default type when not provided', () => {
      const defaultService = new BaseService('default-service');
      expect(defaultService.type).to.equal('base');
    });

    it('should set up debug logging', () => {
      expect(service.log).to.be.a('function');
      expect(service.logError).to.be.a('function');
    });

    it('should inherit from EventEmitter', () => {
      expect(service.on).to.be.a('function');
      expect(service.emit).to.be.a('function');
      expect(service.off).to.be.a('function');
      expect(service.once).to.be.a('function');
    });
  });

  describe('setServiceDependency()', () => {
    it('should add a service dependency', () => {
      service.setServiceDependency('state');
      expect(service._dependencies).to.include('state');
    });

    it('should not add duplicate dependencies', () => {
      service.setServiceDependency('state');
      service.setServiceDependency('state');
      expect(service._dependencies.filter(d => d === 'state').length).to.equal(1);
    });

    it('should return this for chaining', () => {
      const result = service.setServiceDependency('state');
      expect(result).to.equal(service);
    });

    it('should add multiple dependencies', () => {
      service.setServiceDependency('state');
      service.setServiceDependency('position');
      service.setServiceDependency('weather');
      expect(service._dependencies).to.have.lengthOf(3);
    });
  });

  describe('start()', () => {
    it('should start the service', async () => {
      const startingSpy = sandbox.spy();
      const startedSpy = sandbox.spy();
      
      service.on('service:test-service:starting', startingSpy);
      service.on('service:test-service:started', startedSpy);
      
      await service.start();
      
      expect(service.isRunning).to.be.true;
      expect(service.isReady).to.be.true;
      expect(service.lastUpdated).to.be.a('date');
      expect(startingSpy.calledOnce).to.be.true;
      expect(startedSpy.calledOnce).to.be.true;
    });

    it('should not start if already running', async () => {
      service.isRunning = true;
      
      const startingSpy = sandbox.spy();
      service.on('service:test-service:starting', startingSpy);
      
      await service.start();
      
      expect(startingSpy.called).to.be.false;
    });

    it('should emit error on start failure', async () => {
      const errorSpy = sandbox.spy();
      service.on('service:test-service:error', errorSpy);
      
      // Mock a failure by making isReady check throw
      sandbox.stub(service, 'emit').throws(new Error('Start failed'));
      
      try {
        await service.start();
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error.message).to.equal('Start failed');
      }
    });

    it('should wait for dependencies if serviceManager is set', async () => {
      const mockServiceManager = {
        waitForServiceReady: sandbox.stub().resolves(),
        getService: sandbox.stub().returns({ name: 'state' })
      };
      
      service.serviceManager = mockServiceManager;
      service.setServiceDependency('state');
      
      await service.start();
      
      expect(mockServiceManager.waitForServiceReady.calledWith('state', 10000)).to.be.true;
      expect(service.dependencies.state).to.exist;
    });

    it('should handle dependency wait timeout', async () => {
      const mockServiceManager = {
        waitForServiceReady: sandbox.stub().rejects(new Error('Timeout')),
        getService: sandbox.stub()
      };
      
      service.serviceManager = mockServiceManager;
      service.setServiceDependency('state');
      
      try {
        await service.start();
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error.message).to.include('state failed to become ready');
      }
    });

    it('should warn if weather service has no listeners', async () => {
      const weatherService = new BaseService('weather', 'scheduled');
      const mockServiceManager = {
        waitForServiceReady: sandbox.stub().resolves(),
        getService: sandbox.stub().returns({ listenerCount: () => 0 })
      };
      
      weatherService.serviceManager = mockServiceManager;
      
      const consoleWarnStub = sandbox.stub(console, 'warn');
      
      await weatherService.start();
      
      expect(consoleWarnStub.called).to.be.true;
    });

    it('should warn if tidal service has no listeners', async () => {
      const tidalService = new BaseService('tidal', 'scheduled');
      const mockServiceManager = {
        waitForServiceReady: sandbox.stub().resolves(),
        getService: sandbox.stub().returns({ listenerCount: () => 0 })
      };
      
      tidalService.serviceManager = mockServiceManager;
      
      const consoleWarnStub = sandbox.stub(console, 'warn');
      
      await tidalService.start();
      
      expect(consoleWarnStub.called).to.be.true;
    });
  });

  describe('_waitForDependencies()', () => {
    it('should return immediately if no dependencies', async () => {
      await service._waitForDependencies(null);
      expect(true).to.be.true; // Should complete without error
    });

    it('should wait for all dependencies', async () => {
      const mockServiceManager = {
        waitForServiceReady: sandbox.stub().resolves(),
        getService: sandbox.stub().returns({ name: 'state' })
      };
      
      service.setServiceDependency('state');
      service.setServiceDependency('position');
      
      await service._waitForDependencies(mockServiceManager);
      
      expect(mockServiceManager.waitForServiceReady.calledTwice).to.be.true;
      expect(service.dependencies.state).to.exist;
      expect(service.dependencies.position).to.exist;
    });

    it('should throw on dependency failure', async () => {
      const mockServiceManager = {
        waitForServiceReady: sandbox.stub().rejects(new Error('Failed')),
        getService: sandbox.stub()
      };
      
      service.setServiceDependency('state');
      
      try {
        await service._waitForDependencies(mockServiceManager);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error.message).to.include('state failed to become ready');
      }
    });

    it('should use custom timeout', async () => {
      const mockServiceManager = {
        waitForServiceReady: sandbox.stub().resolves(),
        getService: sandbox.stub().returns({ name: 'state' })
      };
      
      service.setServiceDependency('state');
      
      await service._waitForDependencies(mockServiceManager, 5000);
      
      expect(mockServiceManager.waitForServiceReady.calledWith('state', 5000)).to.be.true;
    });
  });

  describe('stop()', () => {
    it('should stop the service', async () => {
      const stoppingSpy = sandbox.spy();
      const stoppedSpy = sandbox.spy();
      
      service.on('service:test-service:stopping', stoppingSpy);
      service.on('service:test-service:stopped', stoppedSpy);
      
      service.isRunning = true;
      await service.stop();
      
      expect(service.isRunning).to.be.false;
      expect(service.isReady).to.be.false;
      expect(stoppingSpy.calledOnce).to.be.true;
      expect(stoppedSpy.calledOnce).to.be.true;
    });

    it('should not stop if not running', async () => {
      const stoppingSpy = sandbox.spy();
      service.on('service:test-service:stopping', stoppingSpy);
      
      await service.stop();
      
      expect(stoppingSpy.called).to.be.false;
    });

    it('should emit stopped event with timestamp', async () => {
      const stoppedSpy = sandbox.spy();
      service.on('service:test-service:stopped', stoppedSpy);
      
      service.isRunning = true;
      await service.stop();
      
      expect(stoppedSpy.calledOnce).to.be.true;
      const callArgs = stoppedSpy.firstCall.args[0];
      expect(callArgs).to.have.property('timestamp');
    });

    it('should emit generic stopped event', async () => {
      const stoppedSpy = sandbox.spy();
      service.on('stopped', stoppedSpy);
      
      service.isRunning = true;
      await service.stop();
      
      expect(stoppedSpy.calledOnce).to.be.true;
    });

    it('should emit error on stop failure', async () => {
      const errorSpy = sandbox.spy();
      service.on('service:test-service:error', errorSpy);
      
      service.isRunning = true;
      sandbox.stub(service, 'emit').throws(new Error('Stop failed'));
      
      try {
        await service.stop();
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error.message).to.equal('Stop failed');
      }
    });
  });

  describe('getStatus()', () => {
    it('should return correct status object', () => {
      service.isRunning = true;
      service.isReady = true;
      service.lastUpdated = new Date();
      
      const status = service.getStatus();
      
      expect(status).to.have.property('name', 'test-service');
      expect(status).to.have.property('type', 'base');
      expect(status).to.have.property('isRunning', true);
      expect(status).to.have.property('isReady', true);
      expect(status).to.have.property('lastUpdated');
    });

    it('should return null lastUpdated when not started', () => {
      const status = service.getStatus();
      
      expect(status.lastUpdated).to.be.null;
    });
  });

  describe('onReady()', () => {
    it('should call listener immediately if ready', () => {
      const listener = sandbox.stub();
      service.isReady = true;
      
      service.onReady(listener);
      
      expect(listener.calledOnce).to.be.true;
    });

    it('should register listener if not ready', () => {
      const listener = sandbox.stub();
      service.isReady = false;
      
      service.onReady(listener);
      
      expect(listener.called).to.be.false;
      
      // Emit started event to trigger listener
      service.emit('service:test-service:started');
      expect(listener.calledOnce).to.be.true;
    });

    it('should return this for chaining', () => {
      const result = service.onReady(() => {});
      expect(result).to.equal(service);
    });
  });

  describe('waitUntilReady()', () => {
    it('should resolve immediately if ready', async () => {
      service.isReady = true;
      
      await service.waitUntilReady();
      expect(true).to.be.true; // Should resolve without error
    });

    it('should resolve when ready event is emitted', async () => {
      service.isReady = false;
      
      const promise = service.waitUntilReady();
      
      // Simulate ready event
      setTimeout(() => {
        service.isReady = true;
        service.emit('ready');
      }, 10);
      
      await promise;
      expect(true).to.be.true;
    });

    it('should timeout if not ready', async () => {
      service.isReady = false;
      
      try {
        await service.waitUntilReady(100);
        expect.fail('Should have timed out');
      } catch (error) {
        expect(error.message).to.include('Timed out waiting');
      }
    });

    it('should use custom timeout', async () => {
      service.isReady = false;
      
      try {
        await service.waitUntilReady(2000);
        expect.fail('Should have timed out');
      } catch (error) {
        expect(error.message).to.include('Timed out waiting');
      }
    });

    it('should resolve if ready during timeout', async () => {
      service.isReady = false;
      
      const promise = service.waitUntilReady(5000);
      
      setTimeout(() => {
        service.isReady = true;
        service.emit('ready');
      }, 100);
      
      await promise;
      expect(true).to.be.true;
    });

    it('should handle race condition where ready is set before listener', async () => {
      service.isReady = false;
      
      const promise = service.waitUntilReady(5000);
      
      // Set ready immediately but don't emit event
      service.isReady = true;
      
      // The implementation checks again after setting up listener
      setTimeout(() => {
        service.emit('ready');
      }, 10);
      
      await promise;
      expect(true).to.be.true;
    });
  });

  describe('Edge Cases', () => {
    it('should handle rapid start/stop cycles', async () => {
      await service.start();
      await service.stop();
      await service.start();
      await service.stop();
      
      expect(service.isRunning).to.be.false;
    });

    it('should handle multiple onReady listeners', () => {
      const listener1 = sandbox.stub();
      const listener2 = sandbox.stub();
      
      service.isReady = false;
      service.onReady(listener1);
      service.onReady(listener2);
      
      service.emit('service:test-service:started');
      
      expect(listener1.calledOnce).to.be.true;
      expect(listener2.calledOnce).to.be.true;
    });

    it('should handle dependency array modifications', async () => {
      service.setServiceDependency('state');
      service._dependencies.push('position');
      
      const mockServiceManager = {
        waitForServiceReady: sandbox.stub().resolves(),
        getService: sandbox.stub().returns({ name: 'state' })
      };
      
      service.serviceManager = mockServiceManager;
      
      await service.start();
      
      expect(mockServiceManager.waitForServiceReady.calledTwice).to.be.true;
    });

    it('should handle null serviceManager gracefully', async () => {
      service.serviceManager = null;
      service.setServiceDependency('state');
      
      await service.start();
      
      expect(service.isRunning).to.be.true;
    });

    it('should handle undefined serviceManager gracefully', async () => {
      service.serviceManager = undefined;
      service.setServiceDependency('state');
      
      await service.start();
      
      expect(service.isRunning).to.be.true;
    });
  });
});
