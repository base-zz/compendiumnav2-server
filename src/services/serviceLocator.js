import { serviceManager } from './ServiceManager.js';

console.log('[SERVICE] serviceLocator module loaded');

export function getService(name) {
  return serviceManager.getService(name);
}

export function requireService(name) {
  const service = serviceManager.getService(name);
  if (!service) {
    throw new Error(`Service '${name}' is not registered`);
  }
  return service;
}
