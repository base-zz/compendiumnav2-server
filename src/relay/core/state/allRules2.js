import { anchorRules } from './anchorRules2.js';
import { navigationRules } from './navigationRules2.js';
import { weatherRules } from './weatherRules2.js';

console.log(`[allRules2.js] Imported anchorRules length: ${anchorRules?.length ?? 'undefined'}`);
console.log(`[allRules2.js] Imported navigationRules length: ${navigationRules?.length ?? 'undefined'}`);
console.log(`[allRules2.js] Imported weatherRules length: ${weatherRules?.length ?? 'undefined'}`);

/**
 * Combined rules for the optimized rule engine
 * Rules are evaluated in order, so put higher priority rules first
 */
const combinedBeforeMap = [
  ...anchorRules,
  ...navigationRules,
  ...weatherRules
];
console.log(`[allRules2.js] Combined rules before map, length: ${combinedBeforeMap.length}`);

export const allRules = combinedBeforeMap.map((rule, index) => ({
  ...rule,
  // Add priority based on position (earlier = higher priority)
  priority: rule.priority || (index < 5 ? 'high' : 'normal'),
  // Add unique ID for tracking
  id: rule.name ? `rule_${index}_${rule.name.toLowerCase().replace(/\s+/g, '_')}` : `rule_${index}_unnamed`
}));

// Export a function to get rules with custom options
export function getRules(options = {}) {
  const filteredRules = allRules.filter(rule => {
    if (options.onlyHighPriority) {
      return rule.priority === 'high';
    }
    return true;
  });
  console.log(`[allRules2.js] getRules() returning ${filteredRules.length} rules with options: ${JSON.stringify(options)}`);
  return filteredRules;
}
