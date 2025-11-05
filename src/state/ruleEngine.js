/**
 * Rule engine for evaluating state and determining actions
 */
export class RuleEngine {
  constructor(rules) {
    this.rules = rules || [];
  }

  /**
   * Evaluate the current state against all rules
   * @param {Object} state - The current state
   * @param {Object} env - Additional environment variables
   * @returns {Array} - Actions to take based on matching rules
   */
  evaluate(state, env = {}) {
    const actions = [];
    
    // Evaluate each rule against the current state
    this.rules.forEach(rule => {
      try {
        // Check if the rule's condition is met
        if (rule.condition(state, env)) {
          // console.log(`[RULE-ENGINE] Rule matched: ${rule.name}`);
          actions.push(rule.action);
        }
      } catch (error) {
        console.error(`[RULE-ENGINE] Error evaluating rule ${rule.name}:`, error);
      }
    });
    
    return actions;
  }
}
