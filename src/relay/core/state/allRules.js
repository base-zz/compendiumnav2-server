/**
 * Combined rules from all domains
 * 
 * This file serves as the central registry for all rule domains in the system.
 * New rule domains should be imported and added to the AllRules array.
 */

import { AnchorRules } from './anchorRules.js';
import { NavigationRules } from './navigationRules.js';
import { WeatherRules } from './weatherRules.js';

// Import future rule domains here

/**
 * Combined rules from all domains
 * This allows the StateManager to use a single RuleEngine instance
 * for evaluating all rules across different domains
 */
export const AllRules = [
  ...AnchorRules,
  ...NavigationRules,
  ...WeatherRules,
  
  // Add future rule domains here
  // ...NavigationRules,
];
