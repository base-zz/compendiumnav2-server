import { EventEmitter } from 'events';
import debounce from 'lodash/debounce.js';
import debug from 'debug';

const log = debug('rule-engine2');
const logWarn = debug('rule-engine2:warn');
const logError = debug('rule-engine2:error');

/**
 * Optimized Rule Engine for Raspberry Pi (including Pi Zero)
 * Features:
 * - Selective rule evaluation based on state changes
 * - Debounced evaluations to prevent thrashing
 * - Memory-efficient state management
 * - Performance monitoring
 */
export class RuleEngine2 extends EventEmitter {
  /**
   * Create a new optimized rule engine
   * @param {Object} options - Configuration options
   * @param {number} [options.evaluationInterval=1000] - Minimum ms between evaluations
   * @param {number} [options.maxConditionsPerRule=5] - Maximum conditions per rule
   * @param {number} [options.maxRules=20] - Maximum number of rules
   */
  constructor(options = {}) {
    super();
    this.options = {
      evaluationInterval: 1000, // 1 second default
      maxConditionsPerRule: 5,
      maxRules: 20,
      ...options
    };
    
    this.rules = [];
    this.ruleDependencies = new Map(); // path -> rule[]
    this.stateCache = new Map();
    this.lastEvaluation = 0;
    this.pendingEvaluation = false;
    this.stats = {
      evaluations: 0,
      rulesTriggered: 0,
      avgEvalTime: 0,
      lastEvalTime: 0
    };

    // Create debounced evaluation function
    this.debouncedEvaluate = debounce(
      () => this.evaluateFromCache(),
      this.options.evaluationInterval,
      { leading: true, trailing: true, maxWait: 5000 }
    );
  }

  /**
   * Add a rule to the engine
   * @param {Object} rule - The rule to add
   * @param {Function} rule.condition - Function that evaluates to true/false
   * @param {Function} rule.action - Function to execute if condition is true
   * @param {string[]} rule.dependsOn - Array of state paths this rule depends on
   * @param {string} [rule.name] - Optional name for debugging
   * @param {string} [rule.priority='normal'] - Priority: 'high', 'normal', 'low'
   */
  addRule(rule) {
    if (this.rules.length >= this.options.maxRules) {
      logWarn(`Maximum rules (${this.options.maxRules}) reached, skipping rule`);
      return false;
    }

    // Validate rule
    if (typeof rule.condition !== 'function' || typeof rule.action !== 'function') {
      throw new Error('Rule must have condition and action functions');
    }

    if (!Array.isArray(rule.dependsOn) || rule.dependsOn.length === 0) {
      logWarn('Rule added without dependencies, will be evaluated on every state change');
    } else if (rule.dependsOn.length > this.options.maxConditionsPerRule) {
      logWarn(`Rule has ${rule.dependsOn.length} dependencies (max ${this.options.maxConditionsPerRule})`);
    }

    // Add to rules array
    const ruleWithDefaults = {
      priority: 'normal',
      ...rule,
      id: `rule_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`
    };

    this.rules.push(ruleWithDefaults);
    log(`Added rule: ${ruleWithDefaults.name || ruleWithDefaults.id}`);

    // Update dependencies map
    rule.dependsOn?.forEach(path => {
      if (!this.ruleDependencies.has(path)) {
        this.ruleDependencies.set(path, []);
      }
      this.ruleDependencies.get(path).push(ruleWithDefaults);
    });

    return true;
  }

  /**
   * Update the state and trigger rule evaluation
   * @param {Object} stateUpdate - The state changes
   * @param {string} source - Source of the state update (for debugging)
   */
  updateState(stateUpdate, source = 'unspecified') {
    if (!stateUpdate || typeof stateUpdate !== 'object') {
      return;
    }

    // Update state cache
    const changedPaths = this.updateStateCache(stateUpdate);
    
    if (changedPaths.length === 0) {
      return; // No relevant changes
    }

    // Trigger evaluation (debounced)
    this.triggerEvaluation(changedPaths, source);
  }

  /**
   * Trigger rule evaluation
   * @private
   */
  triggerEvaluation(changedPaths = [], source = 'unspecified') {
    // Find rules that depend on changed paths
    const rulesToEvaluate = new Set();
    
    changedPaths.forEach(path => {
      (this.ruleDependencies.get(path) || []).forEach(rule => {
        rulesToEvaluate.add(rule);
      });
    });

    // Add rules with no dependencies (they run on every change)
    this.rules
      .filter(rule => !rule.dependsOn || rule.dependsOn.length === 0)
      .forEach(rule => rulesToEvaluate.add(rule));

    if (rulesToEvaluate.size === 0) {
      return;
    }

    // Schedule evaluation
    this.pendingEvaluation = true;
    this.debouncedEvaluate({
      rules: Array.from(rulesToEvaluate),
      source,
      changedPaths
    });
  }

  /**
   * Evaluate rules against the current state
   * @private
   */
  async evaluateFromCache(evalContext = {}) {
    const startTime = process.hrtime();
    const { rules = this.rules, source = 'manual' } = evalContext;
    
    if (rules.length === 0) {
      return [];
    }

    this.pendingEvaluation = false;
    this.lastEvaluation = Date.now();
    this.stats.evaluations++;

    // Get current state from cache
    const state = Object.fromEntries(this.stateCache);
    
    // Evaluate each rule
    const actions = [];
    const context = { state, source };

    // Sort rules by priority
    const sortedRules = [...rules].sort((a, b) => {
      const priorityOrder = { high: 3, normal: 2, low: 1 };
      return (priorityOrder[b.priority] || 1) - (priorityOrder[a.priority] || 1);
    });

    for (const rule of sortedRules) {
      try {
        const conditionMet = await Promise.resolve(rule.condition(state, context));
        
        if (conditionMet) {
          this.stats.rulesTriggered++;
          const result = await Promise.resolve(rule.action(state, context));
          if (result) {
            actions.push({
              rule: rule.name || rule.id,
              timestamp: new Date().toISOString(),
              ...(typeof result === 'object' ? result : { result })
            });
          }
        }
      } catch (error) {
        logError(`Error evaluating rule ${rule.name || rule.id}: %o`, error);
      }
    }

    // Update stats
    const [seconds, nanoseconds] = process.hrtime(startTime);
    const evalTime = (seconds * 1000) + (nanoseconds / 1e6);
    this.stats.lastEvalTime = evalTime;
    this.stats.avgEvalTime = 
      (this.stats.avgEvalTime * (this.stats.evaluations - 1) + evalTime) / this.stats.evaluations;

    // Emit results
    if (actions.length > 0) {
      this.emit('actions', actions);
    }

    this.emit('evaluation', {
      rulesEvaluated: rules.length,
      actionsTriggered: actions.length,
      evaluationTime: evalTime,
      source
    });

    return actions;
  }

  /**
   * Update the state cache and return changed paths
   * @private
   */
  updateStateCache(update) {
    const changedPaths = [];
    
    const updateRecursive = (obj, path = '') => {
      Object.entries(obj).forEach(([key, value]) => {
        const currentPath = path ? `${path}.${key}` : key;
        
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          updateRecursive(value, currentPath);
        } else {
          const existingValue = this.stateCache.get(currentPath);
          if (!deepEqual(existingValue, value)) {
            this.stateCache.set(currentPath, value);
            changedPaths.push(currentPath);
          }
        }
      });
    };

    updateRecursive(update);
    return changedPaths;
  }

  /**
   * Get current engine statistics
   * @returns {Object} Engine statistics
   */
  getStats() {
    return {
      ...this.stats,
      rulesCount: this.rules.length,
      stateSize: this.stateCache.size,
      lastEvaluation: new Date(this.lastEvaluation).toISOString(),
      memoryUsage: process.memoryUsage()
    };
  }

  /**
   * Clear all rules and state
   */
  clear() {
    this.rules = [];
    this.ruleDependencies.clear();
    this.stateCache.clear();
    this.stats = {
      evaluations: 0,
      rulesTriggered: 0,
      avgEvalTime: 0,
      lastEvalTime: 0
    };
  }
}

// Simple deep equality check for state comparison
function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a.constructor !== b.constructor) return false;

  if (Array.isArray(a)) {
    return a.length === b.length && a.every((val, i) => deepEqual(val, b[i]));
  }

  if (typeof a === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    
    return (
      keysA.length === keysB.length &&
      keysA.every(key => keysB.includes(key) && deepEqual(a[key], b[key]))
    );
  }

  return false;
}

// Export a singleton instance for convenience
export const ruleEngine = new RuleEngine2();
