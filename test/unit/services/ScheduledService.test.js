/**
 * Comprehensive tests for ScheduledService
 * Tests the scheduled service base class
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import ScheduledService from '../../../src/services/ScheduledService.js';

// Mock subclass for testing
class TestScheduledService extends ScheduledService {
  constructor(name, options) {
    super(name, options);
    this.runCalls = 0;
  }

  async run() {
    this.runCalls++;
    return { success: true };
  }
}

describe('ScheduledService', () => {
  let service;
  let sandbox;
  let mockClock;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    service = new TestScheduledService('test-scheduled');
    mockClock = sandbox.useFakeTimers();
  });

  afterEach(() => {
    mockClock.restore();
    sandbox.restore();
  });

  describe('Constructor', () => {
    it('should initialize with correct type', () => {
      expect(service.name).to.equal('test-scheduled');
      expect(service.type).to.equal('scheduled');
    });

    it('should initialize with default options', () => {
      expect(service.options.interval).to.equal(3600000); // 1 hour
      expect(service.options.immediate).to.be.true;
      expect(service.options.runOnInit).to.be.false;
    });

    it('should initialize with custom options', () => {
      const customService = new TestScheduledService('custom', {
        interval: 5000,
        immediate: false,
        runOnInit: true
      });

      expect(customService.options.interval).to.equal(5000);
      expect(customService.options.immediate).to.be.false;
      expect(customService.options.runOnInit).to.be.true;
    });

    it('should initialize task tracking properties', () => {
      expect(service._timeout).to.be.null;
      expect(service._isRunningTask).to.be.false;
      expect(service.runCount).to.equal(0);
      expect(service.lastRun).to.be.null;
      expect(service.nextRun).to.be.null;
      expect(service.lastError).to.be.null;
    });

    it('should inherit from BaseService', () => {
      expect(service.isRunning).to.be.false;
      expect(service.isReady).to.be.false;
      expect(service._dependencies).to.deep.equal([]);
    });
  });

  describe('start()', () => {
    it('should start the service', async () => {
      const startingSpy = sandbox.spy();
      const startedSpy = sandbox.spy();
      
      service.on('service:test-scheduled:starting', startingSpy);
      service.on('service:test-scheduled:started', startedSpy);
      
      await service.start();
      
      expect(service.isRunning).to.be.true;
      expect(service.isReady).to.be.true;
      expect(startingSpy.calledOnce).to.be.true;
      expect(startedSpy.calledOnce).to.be.true;
    });

    it('should not start if already running', async () => {
      service.isRunning = true;
      
      const startingSpy = sandbox.spy();
      service.on('service:test-scheduled:starting', startingSpy);
      
      await service.start();
      
      expect(startingSpy.called).to.be.false;
    });

    it('should schedule next run', async () => {
      await service.start();
      
      expect(service.nextRun).to.be.a('date');
      expect(service._timeout).to.not.be.null;
    });

    it('should run immediately if immediate is true', async () => {
      const taskStartSpy = sandbox.spy();
      service.on('service:test-scheduled:task:start', taskStartSpy);

      await service.start();

      // Advance fake timers to let the immediate task execute
      mockClock.tick(0);

      expect(taskStartSpy.called).to.be.true;
    });

    it('should not run immediately if immediate is false', async () => {
      const serviceNoImmediate = new TestScheduledService('test', { immediate: false });
      const taskStartSpy = sandbox.spy();
      serviceNoImmediate.on('service:test:task:start', taskStartSpy);

      await serviceNoImmediate.start();

      expect(taskStartSpy.called).to.be.false;
    });

    it('should run onInit if runOnInit is true', async () => {
      const serviceOnInit = new TestScheduledService('test', { runOnInit: true });
      const taskStartSpy = sandbox.spy();
      serviceOnInit.on('service:test:task:start', taskStartSpy);

      await serviceOnInit.start();

      expect(taskStartSpy.called).to.be.true;
    });

    it('should emit error on start failure', async () => {
      const errorSpy = sandbox.spy();
      service.on('service:test-scheduled:error', errorSpy);
      
      sandbox.stub(service, 'emit').throws(new Error('Start failed'));
      
      try {
        await service.start();
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error.message).to.equal('Start failed');
      }
    });
  });

  describe('stop()', () => {
    it('should stop the service', async () => {
      const stoppingSpy = sandbox.spy();
      const stoppedSpy = sandbox.spy();
      
      service.on('service:test-scheduled:stopping', stoppingSpy);
      service.on('service:test-scheduled:stopped', stoppedSpy);
      
      service.isRunning = true;
      await service.stop();
      
      expect(service.isRunning).to.be.false;
      expect(service.isReady).to.be.false;
      expect(stoppingSpy.calledOnce).to.be.true;
      expect(stoppedSpy.calledOnce).to.be.true;
    });

    it('should not stop if not running', async () => {
      const stoppingSpy = sandbox.spy();
      service.on('service:test-scheduled:stopping', stoppingSpy);
      
      await service.stop();
      
      expect(stoppingSpy.called).to.be.false;
    });

    it('should clear timeout on stop', async () => {
      await service.start();
      const _timeoutId = service._timeout;

      await service.stop();

      expect(service._timeout).to.be.null;
    });

    it('should handle null timeout gracefully', async () => {
      service._timeout = null;
      service.isRunning = true;
      
      await service.stop();
      
      expect(service.isRunning).to.be.false;
    });
  });

  describe('_scheduleNextRun()', () => {
    it('should schedule next run', async () => {
      service.isRunning = true;
      service.options.interval = 1000;
      
      service._scheduleNextRun(false);
      
      expect(service._timeout).to.not.be.null;
      expect(service.nextRun).to.be.a('date');
    });

    it('should clear existing timeout before scheduling new one', async () => {
      service.isRunning = true;
      service.options.interval = 1000;
      
      service._scheduleNextRun(false);
      const _firstTimeout = service._timeout;
      
      service._scheduleNextRun(false);
      const _secondTimeout = service._timeout;
      
      expect(_firstTimeout).to.not.equal(_secondTimeout);
    });

    it('should not schedule if not running', async () => {
      service.isRunning = false;
      
      service._scheduleNextRun(false);
      
      expect(service._timeout).to.be.null;
    });

    it('should schedule immediate run when immediate is true', async () => {
      service.isRunning = true;
      
      service._scheduleNextRun(true);
      
      expect(service.nextRun).to.be.a('date');
    });

    it('should calculate delay correctly', async () => {
      service.isRunning = true;
      service.options.interval = 5000;
      
      const _before = Date.now();
      service._scheduleNextRun(false);
      const _after = Date.now();
      
      const expectedDelay = 5000;
      const actualDelay = service.nextRun.getTime() - _before;
      
      expect(actualDelay).to.be.approximately(expectedDelay, 100);
    });
  });

  describe('_executeTask()', () => {
    it('should execute the run method', async () => {
      const runStub = sandbox.stub(service, 'run').resolves('result');
      
      await service._executeTask();
      
      expect(runStub.calledOnce).to.be.true;
    });

    it('should emit task:start event', async () => {
      const taskStartSpy = sandbox.spy();
      service.on('service:test-scheduled:task:start', taskStartSpy);
      
      sandbox.stub(service, 'run').resolves();
      
      await service._executeTask();
      
      expect(taskStartSpy.calledOnce).to.be.true;
      const eventData = taskStartSpy.firstCall.args[0];
      expect(eventData).to.have.property('taskId');
      expect(eventData).to.have.property('timestamp');
    });

    it('should emit task:complete event', async () => {
      const taskCompleteSpy = sandbox.spy();
      service.on('service:test-scheduled:task:complete', taskCompleteSpy);
      
      sandbox.stub(service, 'run').resolves('result');
      
      await service._executeTask();
      
      expect(taskCompleteSpy.calledOnce).to.be.true;
      const eventData = taskCompleteSpy.firstCall.args[0];
      expect(eventData).to.have.property('taskId');
      expect(eventData).to.have.property('duration');
      expect(eventData).to.have.property('timestamp');
      expect(eventData).to.have.property('result', 'result');
    });

    it('should increment runCount', async () => {
      sandbox.stub(service, 'run').resolves();
      
      await service._executeTask();
      
      expect(service.runCount).to.equal(1);
    });

    it('should update lastRun', async () => {
      sandbox.stub(service, 'run').resolves();
      
      await service._executeTask();
      
      expect(service.lastRun).to.be.a('date');
    });

    it('should clear lastError on success', async () => {
      service.lastError = new Error('Previous error');
      sandbox.stub(service, 'run').resolves();
      
      await service._executeTask();
      
      expect(service.lastError).to.be.null;
    });

    it('should emit task:error on failure', async () => {
      const taskErrorSpy = sandbox.spy();
      service.on('service:test-scheduled:task:error', taskErrorSpy);
      
      sandbox.stub(service, 'run').rejects(new Error('Task failed'));
      
      try {
        await service._executeTask();
        expect.fail('Should have thrown');
      } catch (_error) {
        expect(_error.message).to.equal('Task failed');
      }
      
      expect(taskErrorSpy.calledOnce).to.be.true;
      const eventData = taskErrorSpy.firstCall.args[0];
      expect(eventData).to.have.property('taskId');
      expect(eventData).to.have.property('error', 'Task failed');
    });

    it('should set lastError on failure', async () => {
      sandbox.stub(service, 'run').rejects(new Error('Task failed'));
      
      try {
        await service._executeTask();
        expect.fail('Should have thrown');
      } catch (_error) {
        // Expected
      }
      
      expect(service.lastError).to.be.a('error');
      expect(service.lastError.message).to.equal('Task failed');
    });

    it('should skip if task is already running', async () => {
      service._isRunningTask = true;
      const runStub = sandbox.stub(service, 'run').resolves();
      
      await service._executeTask();
      
      expect(runStub.called).to.be.false;
    });

    it('should schedule next run after completion', async () => {
      service.isRunning = true;
      service.options.interval = 1000;
      
      sandbox.stub(service, 'run').resolves();
      
      await service._executeTask();
      
      expect(service._timeout).to.not.be.null;
    });

    it('should not schedule next run if not running', async () => {
      service.isRunning = false;
      
      sandbox.stub(service, 'run').resolves();
      
      await service._executeTask();
      
      expect(service._timeout).to.be.null;
    });
  });

  describe('run()', () => {
    it('should throw error by default', async () => {
      const baseService = new ScheduledService('base-test');
      try {
        await baseService.run();
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error.message).to.equal('Subclasses must implement the run method');
      }
    });
  });

  describe('getStatus()', () => {
    it('should return base status plus scheduled properties', () => {
      service.isRunning = true;
      service.isReady = true;
      service.lastUpdated = new Date();
      service.runCount = 5;
      service.lastRun = new Date();
      service.nextRun = new Date();
      service._isRunningTask = true;
      
      const status = service.getStatus();
      
      expect(status).to.have.property('name', 'test-scheduled');
      expect(status).to.have.property('type', 'scheduled');
      expect(status).to.have.property('isRunning', true);
      expect(status).to.have.property('isReady', true);
      expect(status).to.have.property('runCount', 5);
      expect(status).to.have.property('lastRun');
      expect(status).to.have.property('nextRun');
      expect(status).to.have.property('isRunningTask', true);
      expect(status).to.have.property('interval', 3600000);
    });

    it('should return null for optional properties when not set', () => {
      const status = service.getStatus();
      
      expect(status.lastRun).to.be.null;
      expect(status.nextRun).to.be.null;
      expect(status.isRunningTask).to.be.false;
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

    it('should handle task that takes longer than interval', async () => {
      service.isRunning = true;
      service.options.interval = 100;

      const runStub = sandbox.stub(service, 'run').callsFake(async () => {
        await new Promise(resolve => setTimeout(resolve, 200));
      });

      // Start a task
      const taskPromise = service._executeTask();

      // Try to start another task while one is running
      await service._executeTask();

      // The second call should be skipped
      expect(runStub.calledOnce).to.be.true;

      // Advance fake timers to complete the task
      mockClock.tick(200);
      await taskPromise;
    });

    it('should handle run method returning null', async () => {
      sandbox.stub(service, 'run').resolves(null);

      await service._executeTask();

      expect(service.runCount).to.equal(1);
    });

    it('should handle run method returning undefined', async () => {
      sandbox.stub(service, 'run').resolves(undefined);

      await service._executeTask();

      expect(service.runCount).to.equal(1);
    });

    it('should handle error with code property', async () => {
      const taskErrorSpy = sandbox.spy();
      service.on('service:test-scheduled:task:error', taskErrorSpy);
      
      const customError = new Error('Custom error');
      customError.code = 'CUSTOM_CODE';
      sandbox.stub(service, 'run').rejects(customError);
      
      try {
        await service._executeTask();
        expect.fail('Should have thrown');
      } catch (_error) {
        // Expected
      }
      
      const eventData = taskErrorSpy.firstCall.args[0];
      expect(eventData.code).to.equal('CUSTOM_CODE');
    });

    it('should include stack trace in development mode', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      
      const taskErrorSpy = sandbox.spy();
      service.on('service:test-scheduled:task:error', taskErrorSpy);
      
      sandbox.stub(service, 'run').rejects(new Error('Test error'));
      
      try {
        await service._executeTask();
        expect.fail('Should have thrown');
      } catch (_error) {
        // Expected
      }
      
      const eventData = taskErrorSpy.firstCall.args[0];
      expect(eventData.stack).to.be.a('string');
      
      process.env.NODE_ENV = originalEnv;
    });

    it('should not include stack trace in production mode', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      
      const taskErrorSpy = sandbox.spy();
      service.on('service:test-scheduled:task:error', taskErrorSpy);
      
      sandbox.stub(service, 'run').rejects(new Error('Test error'));
      
      try {
        await service._executeTask();
        expect.fail('Should have thrown');
      } catch (_error) {
        // Expected
      }
      
      const eventData = taskErrorSpy.firstCall.args[0];
      expect(eventData.stack).to.be.undefined;
      
      process.env.NODE_ENV = originalEnv;
    });

    it('should handle zero interval', async () => {
      const serviceZeroInterval = new ScheduledService('test', { interval: 0 });
      serviceZeroInterval.isRunning = true;
      
      serviceZeroInterval._scheduleNextRun(false);
      
      expect(serviceZeroInterval._timeout).to.not.be.null;
    });

    it('should handle negative interval', async () => {
      const serviceNegativeInterval = new ScheduledService('test', { interval: -1000 });
      serviceNegativeInterval.isRunning = true;
      
      serviceNegativeInterval._scheduleNextRun(false);
      
      expect(serviceNegativeInterval._timeout).to.not.be.null;
    });
  });
});
