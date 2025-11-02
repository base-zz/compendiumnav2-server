import { ClientSyncCoordinator } from './ClientSyncCoordinator.js';
import { getStateManager } from '../core/state/StateManager.js';

let coordinatorInstance = null;

/**
 * Retrieve a shared ClientSyncCoordinator instance.
 * @param {Object} [options]
 * @param {import('../core/state/StateManager.js').StateManager} [options.stateManager]
 * @returns {ClientSyncCoordinator}
 */
export function getClientSyncCoordinator(options = {}) {
  const manager = options.stateManager || coordinatorInstance?.stateManager || getStateManager();

  if (!manager) {
    throw new Error('ClientSyncCoordinator requires a state manager');
  }

  if (!coordinatorInstance) {
    coordinatorInstance = new ClientSyncCoordinator({ stateManager: manager });
  }

  return coordinatorInstance;
}

/**
 * Replace the shared coordinator instance. Primarily for testing.
 * @param {ClientSyncCoordinator|null} instance
 */
export function setClientSyncCoordinator(instance) {
  if (coordinatorInstance && coordinatorInstance !== instance) {
    coordinatorInstance.dispose();
  }
  coordinatorInstance = instance;
}

/**
 * Dispose and clear the shared coordinator instance.
 */
export function resetClientSyncCoordinator() {
  if (coordinatorInstance) {
    coordinatorInstance.dispose();
    coordinatorInstance = null;
  }
}
