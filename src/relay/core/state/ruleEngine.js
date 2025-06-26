/**
 * Rule engine for evaluating state and determining actions
 */
export class RuleEngine {
  constructor(rules) {
    this.rules = rules || [];
  }

  /**
   * Evaluate all rules against the current state
   * @param {Object} state - The current application state
   * @param {Object} context - Evaluation context containing currentState, previousState, and env
   * @returns {Array} - Actions to take based on matching rules
   */
  evaluate(state, context = {}) {
    const actions = [];
    const currentState = context.currentState || state;
    const previousState = context.previousState || {};
    const env = context.env || {};
    
    console.log(`[RULE-ENGINE] 🔄 Starting evaluation of ${this.rules.length} rules`);
    console.log(`[RULE-ENGINE] Current state keys:`, Object.keys(currentState));
    
    // Log anchor state for debugging
    if (currentState.anchor) {
      console.log('[RULE-ENGINE] Current anchor state:', JSON.stringify({
        anchorDeployed: currentState.anchor.anchorDeployed,
        timestamp: currentState.anchor.timestamp,
        location: currentState.anchor.anchorLocation?.position,
        rode: currentState.anchor.rode
      }, null, 2));
    }
    
    if (previousState.anchor) {
      console.log('[RULE-ENGINE] Previous anchor state:', JSON.stringify({
        anchorDeployed: previousState.anchor.anchorDeployed,
        timestamp: previousState.anchor.timestamp,
        location: previousState.anchor.anchorLocation?.position,
        rode: previousState.anchor.rode
      }, null, 2));
    }
    
    // Evaluate each rule against the current state
    this.rules.forEach((rule, index) => {
      const ruleStart = Date.now();
      const ruleNum = `[${String(index + 1).padStart(2, '0')}/${this.rules.length}]`;
      
      try {
        console.log(`[RULE-ENGINE] ${ruleNum} Evaluating rule: ${rule.name}`);
        
        // Check if the rule's condition is met
        // Pass both current and previous state to the condition function
        const conditionMet = rule.condition(currentState, previousState, env);
        const evalTime = Date.now() - ruleStart;
        
        if (conditionMet) {
          console.log(`[RULE-ENGINE] ${ruleNum} ✅ [${evalTime}ms] Rule matched: ${rule.name}`);
          
          // Process the action to ensure it has the correct format
          let action = rule.action;
          if (typeof action === 'function') {
            console.log(`[RULE-ENGINE] ${ruleNum} Executing action function for rule: ${rule.name}`);
            action = action(currentState, previousState, env);
            console.log(`[RULE-ENGINE] ${ruleNum} Action result:`, JSON.stringify({
              type: action?.type,
              hasAlertData: !!action?.alertData || !!action?.data,
              hasResolutionData: !!action?.resolutionData
            }, null, 2));
          }
          
          if (action) {
            console.log(`[RULE-ENGINE] ${ruleNum} Adding action: ${action.type} for rule: ${rule.name}`);
            
            // Ensure alertData is properly set for CREATE_ALERT actions
            if (action.type === 'CREATE_ALERT' || action.type === 'RESOLVE_ALERTS') {
              if (!action.alertData && action.data) {
                console.log(`[RULE-ENGINE] ${ruleNum} Migrating action.data to action.alertData`);
                action.alertData = action.data;
                delete action.data;
              }
              
              console.log(`[RULE-ENGINE] ${ruleNum} Action details:`, JSON.stringify({
                type: action.type,
                trigger: action.trigger,
                alertData: action.alertData ? '[Object]' : undefined,
                resolutionData: action.resolutionData ? '[Object]' : undefined
              }, null, 2));
            }
            
            actions.push(action);
          } else {
            console.warn(`[RULE-ENGINE] ${ruleNum} No action returned for rule: ${rule.name}`);
          }
        } else {
          console.log(`[RULE-ENGINE] ${ruleNum} ❌ [${evalTime}ms] Rule did not match: ${rule.name}`);
        }
      } catch (error) {
        console.error(`[RULE-ENGINE] Error evaluating rule ${rule.name}:`, error);
      }
    });
    
    console.log(`[RULE-ENGINE] Evaluation complete. Generated ${actions.length} actions.`);
    
    // Log the first few actions for debugging
    if (actions.length > 0) {
      console.log('[RULE-ENGINE] Sample actions:', 
        actions.slice(0, 3).map(a => ({
          type: a.type,
          trigger: a.trigger,
          hasAlertData: !!(a.alertData || a.data)
        }))
      );
    }
    
    return actions;
  }
}
