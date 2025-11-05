/**
 * Combined rules from all domains
 * 
 * This file serves as the central registry for all rule domains in the system.
 * New rule domains should be imported and added to the AllRules array.
 */

import { AlertRules } from './alertRules.js';

// Import future rule domains here
// import { NavigationRules } from './navigationRules.js';
// import { WeatherRules } from './weatherRules.js';

/**
 * Combined rules from all domains
 * This allows the StateManager to use a single RuleEngine instance
 * for evaluating all rules across different domains
 */
export const AllRules = [
  ...AlertRules,  // Contains anchor alert rules (critical range, dragging, AIS proximity)
  
  // Add future rule domains here
  // ...NavigationRules,
  // ...WeatherRules,
];
