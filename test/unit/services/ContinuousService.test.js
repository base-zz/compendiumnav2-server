/**
 * Comprehensive tests for ContinuousService
 * Tests the continuous service base class
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import ContinuousService from '../../../src/services/ContinuousService.js';

describe('ContinuousService', () => {
  let service;
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    service = new ContinuousService('test-continuous');
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('Constructor', () => {
    it('should initialize with correct type', () => {
      expect(service.name).to.equal('test-continuous');
      expect(service.type).to.equal('continuous');
    });

    it('should inherit from BaseService', () => {
      expect(service.isRunning).to.be.false;
      expect(service.isReady).to.be.false;
      expect(service._dependencies).to.deep.equal([]);
      expect(service.dependencies).to.deep.equal({});
    });

    it('should have BaseService methods', () => {
      expect(service.start).to.be.a('function');
      expect(service.stop).to.be.a('function');
      expect(service.getStatus).to.be.a('function');
      expect(service.setServiceDependency).to.be.a('function');
    });
  });

  describe('start()', () => {
    it('should start the service', async () => {
      const startingSpy = sandbox.spy();
      const startedSpy = sandbox.spy();
      
      service.on('service:test-continuous:starting', startingSpy);
      service.on('service:test-continuous:started', startedSpy);
      
      await service.start();
      
      expect(service.isRunning).to.be.true;
      expect(service.isReady).to.be.true;
      expect(startingSpy.calledOnce).to.be.true;
      expect(startedSpy.calledOnce).to.be.true;
    });

    it('should not start if already running', async () => {
      service.isRunning = true;
      
      const startingSpy = sandbox.spy();
      service.on('service:test-continuous:starting', startingSpy);
      
      await service.start();
      
      expect(startingSpy.called).to.be.false;
    });

    it('should call parent start method', async () => {
      const parentStartStub = sandbox.stub(ContinuousService.prototype.__proto__, 'start').resolves();
      
      await service.start();
      
      expect(parentStartStub.calledOnce).to.be.true;
      parentStartStub.restore();
    });
  });

  describe('stop()', () => {
    it('should stop the service', async () => {
      const stoppingSpy = sandbox.spy();
      const stoppedSpy = sandbox.spy();
      
      service.on('service:test-continuous:stopping', stoppingSpy);
      service.on('service:test-continuous:stopped', stoppedSpy);
      
      service.isRunning = true;
      await service.stop();
      
      expect(service.isRunning).to.be.false;
      expect(service.isReady).to.be.false;
      expect(stoppingSpy.calledOnce).to.be.true;
      expect(stoppedSpy.calledOnce).to.be.true;
    });

    it('should not stop if not running', async () => {
      const stoppingSpy = sandbox.spy();
      service.on('service:test-continuous:stopping', stoppingSpy);
      
      await service.stop();
      
      expect(stoppingSpy.called).to.be.false;
    });

    it('should call parent stop method', async () => {
      const parentStopStub = sandbox.stub(ContinuousService.prototype.__proto__, 'stop').resolves();
      
      service.isRunning = true;
      await service.stop();
      
      expect(parentStopStub.calledOnce).to.be.true;
      parentStopStub.restore();
    });

    it('should log stop message', async () => {
      const logStub = sandbox.stub(service, 'log');
      
      service.isRunning = true;
      await service.stop();
      
      expect(logStub.calledWith('Continuous service stopped')).to.be.true;
    });
  });

  describe('Inherited Methods', () => {
    it('should have getStatus from BaseService', () => {
      service.isRunning = true;
      service.isReady = true;
      service.lastUpdated = new Date();
      
      const status = service.getStatus();
      
      expect(status).to.have.property('name', 'test-continuous');
      expect(status).to.have.property('type', 'continuous');
      expect(status).to.have.property('isRunning', true);
      expect(status).to.have.property('isReady', true);
    });

    it('should have setServiceDependency from BaseService', () => {
      service.setServiceDependency('state');
      expect(service._dependencies).to.include('state');
    });

    it('should have onReady from BaseService', () => {
      const listener = sandbox.stub();
      service.isReady = true;
      service.onReady(listener);
      expect(listener.calledOnce).to.be.true;
    });

    it('should have waitUntilReady from BaseService', async () => {
      service.isReady = true;
      await service.waitUntilReady();
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

    it('should handle start when dependencies are set', async () => {
      service.setServiceDependency('state');
      const mockServiceManager = {
        waitForServiceReady: sandbox.stub().resolves(),
        getService: sandbox.stub().returns({ name: 'state' })
      };
      
      service.serviceManager = mockServiceManager;
      
      await service.start();
      
      expect(service.isRunning).to.be.true;
    });

    it('should handle stop with parent errors', async () => {
      const parentStopStub = sandbox.stub(ContinuousService.prototype.__proto__, 'stop').rejects(new Error('Stop failed'));
      
      service.isRunning = true;
      
      try {
        await service.stop();
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error.message).to.equal('Stop failed');
      }
      
      parentStopStub.restore();
    });

    it('should handle start with parent errors', async () => {
      const parentStartStub = sandbox.stub(ContinuousService.prototype.__proto__, 'start').rejects(new Error('Start failed'));
      
      try {
        await service.start();
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error.message).to.equal('Start failed');
      }
      
      parentStartStub.restore();
    });
  });
});
