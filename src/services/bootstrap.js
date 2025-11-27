import { serviceManager } from './ServiceManager.js';

console.log('[BOOTSTRAP] bootstrap.js loaded');

function assertServiceName(entry) {
  if (!entry || !entry.name) {
    throw new Error('Service entry is missing required "name" property');
  }
}

function resolveDependencies(dependencies) {
  console.log('[BOOTSTRAP] resolveDependencies called with', dependencies);
  const resolved = {};
  if (!Array.isArray(dependencies)) {
    return resolved;
  }
  for (const depName of dependencies) {
    if (!depName) {
      throw new Error('Encountered empty dependency name');
    }
    const service = serviceManager.getService(depName);
    if (!service) {
      throw new Error(`Dependency '${depName}' has not been registered yet`);
    }
    resolved[depName] = service;
  }
  return resolved;
}

function instantiateService(entry) {
  console.log('[BOOTSTRAP] instantiateService called for', entry?.name);
  const create = entry.create;
  const factory = entry.factory;
  const modulePath = entry.module;
  const options = entry.options;
  const dependencies = entry.dependencies;

  if (create && typeof create === 'function') {
    const resolvedDeps = resolveDependencies(dependencies);
    return create({ dependencies: resolvedDeps, options });
  }

  if (factory && typeof factory === 'function') {
    const resolvedDeps = resolveDependencies(dependencies);
    return factory({ dependencies: resolvedDeps, options });
  }

  if (modulePath) {
    throw new Error('Dynamic module loading is not yet supported in this bootstrap version');
  }

  throw new Error('Service entry must define a create function, factory function, or module path');
}

export async function bootstrapServices(serviceManifest) {
  console.log('[BOOTSTRAP] bootstrapServices called with manifest', Array.isArray(serviceManifest) ? serviceManifest.map((v) => v.name) : serviceManifest);
  if (!serviceManifest || !Array.isArray(serviceManifest)) {
    throw new Error('Service manifest must be an array of service definitions');
  }

  const failures = [];

  for (const entry of serviceManifest) {
    try {
      assertServiceName(entry);
      if (serviceManager.getService(entry.name)) {
        throw new Error(`Service '${entry.name}' has already been registered`);
      }
      const instance = instantiateService(entry);
      serviceManager.registerService(entry.name, instance);
      console.log('[BOOTSTRAP] registered service', entry.name);
    } catch (error) {
      failures.push({ name: entry?.name, reason: error.message });
    }
  }

  return { failures };
}

export async function startRegisteredServices() {
  return serviceManager.startAll();
}
