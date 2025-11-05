# Alert System - Server-Side Components Restored

## Files Restored from Git History

### 1. AlertService.js
**Location**: `src/services/AlertService.js`
**Source**: Commit `4313f22^` from `src/relay/core/services/AlertService.js`

**Purpose**: Server-side alert creation and management service

**Key Methods**:
- `createAlert(alertData)` - Creates a new alert and adds it to state
- `resolveAlertsByTrigger(triggerType, resolutionData)` - Auto-resolves alerts by trigger type
- `_createResolutionNotification(triggerType, resolutionData)` - Creates resolution notifications
- `_ensureAlertsStructure()` - Initializes alert structure in state

**Dependencies**:
- `crypto` (Node.js built-in)
- `../shared/alertDatum.js` (BASE_ALERT_DATUM)

**Integration Required**:
- Needs to be instantiated with a StateManager instance
- Should be called when alert conditions are met

---

### 2. alertRules.js
**Location**: `src/state/alertRules.js`
**Source**: Commit `4313f22^` from `src/relay/core/state/alertRules.js`

**Purpose**: Defines hardcoded system alert rules for automatic monitoring

**Rules Included**:
1. **Critical Range Detection**
   - Triggers when boat exceeds critical range from anchor
   - Auto-resolvable: Yes
   - Level: Critical

2. **Anchor Dragging Detection**
   - Triggers when distance to anchor exceeds rode length + buffer
   - Auto-resolvable: No (requires manual acknowledgment)
   - Level: Critical

3. **AIS Proximity Detection**
   - Triggers when AIS targets enter warning radius
   - Auto-resolvable: Yes
   - Level: Warning

**Exports**:
- `AlertRules` - Array of rule objects with:
  - `name` - Rule name
  - `condition(state)` - Function that evaluates if rule should trigger
  - `action.type` - Action to take (CREATE_ALERT)
  - `action.alertData(state)` - Function that generates alert data

---

## Integration Steps

### 1. Wire AlertService into StateManager

The AlertService needs to be instantiated and integrated with your state management:

```javascript
// In your StateManager or similar
import { AlertService } from './services/AlertService.js';

class StateManager {
  constructor() {
    this.alertService = new AlertService(this);
    // ...
  }
}
```

### 2. Process Alert Rules on State Changes

You'll need to evaluate alert rules whenever state changes:

```javascript
import { AlertRules } from './state/alertRules.js';

// In your state update handler
function onStateUpdate(newState) {
  // Evaluate each alert rule
  AlertRules.forEach(rule => {
    if (rule.condition(newState)) {
      const alertData = rule.action.alertData(newState);
      this.alertService.createAlert(alertData);
    }
  });
}
```

### 3. Handle Alert Commands from Client

The client sends alerts via `relayConnectionAdapter.sendAlert()`:

```javascript
// Handle 'alert' service commands
if (serviceName === 'alert' && action === 'update') {
  this.alertService.createAlert(data);
}
```

---

## Client-Server Alert Flow

### Anchor Alerts (Client-Initiated)
```
Client (AnchorView.vue)
  ↓ detects condition
createAnchorDraggingAlert()
  ↓ calls
relayConnectionAdapter.sendAlert()
  ↓ sends command
Server receives 'alert' 'update' command
  ↓ calls
AlertService.createAlert()
  ↓ adds to
state.alerts.active[]
```

### System Alerts (Server-Initiated)
```
Server state update
  ↓ triggers
AlertRules evaluation
  ↓ condition met
AlertService.createAlert()
  ↓ adds to
state.alerts.active[]
  ↓ broadcasts
Client receives state update
  ↓ displays in
AlertView.vue
```

---

## Next Steps

1. ✅ Files restored to server project
2. ⬜ Integrate AlertService with StateManager
3. ⬜ Add alert rule evaluation to state update cycle
4. ⬜ Handle 'alert' service commands from client
5. ⬜ Test anchor dragging alerts
6. ⬜ Test AIS proximity alerts
7. ⬜ Add user-defined alert rule processing (optional)

---

## Notes

- The AlertService uses `structuredClone()` which requires Node.js 17+
- Alert rules include distance calculation utilities
- Auto-resolvable alerts are automatically cleared when conditions return to normal
- Non-auto-resolvable alerts (like anchor dragging) require manual acknowledgment

---

## Additional Files Restored (Rule Engine Integration)

### 3. ruleEngine.js
**Location**: `src/state/ruleEngine.js`
**Source**: Commit `4313f22^` from `src/relay/core/state/ruleEngine.js`

**Purpose**: Generic rule evaluation engine that processes rules against state

**Key Methods**:
- `evaluate(state, env)` - Evaluates all rules and returns actions to take

**Usage**:
```javascript
const ruleEngine = new RuleEngine(AllRules);
const actions = ruleEngine.evaluate(currentState);
// Returns array of actions like:
// [{ type: 'CREATE_ALERT', alertData: {...} }]
```

---

### 4. allRules.js  
**Location**: `src/state/allRules.js`
**Source**: Commit `4313f22^` from `src/relay/core/state/allRules.js`

**Purpose**: Central registry combining all rule domains

**Structure**:
```javascript
export const AllRules = [
  ...AnchorRules,      // From alertRules.js
  ...NavigationRules,  // (if exists)
  ...WeatherRules,     // (if exists)
];
```

**Note**: You'll need to update this to import from `./alertRules.js` instead of separate domain files

---

## Complete Alert System Architecture

### Server-Side Flow

```
State Update
  ↓
StateManager.updateState()
  ↓
RuleEngine.evaluate(state)
  ↓
Returns actions: [
  { type: 'CREATE_ALERT', alertData: {...} },
  { type: 'RESOLVE_ALERTS', trigger: 'critical_range' }
]
  ↓
AlertService.processAlertActions(actions)
  ↓
For each CREATE_ALERT:
  - AlertService.createAlert(alertData)
  - Adds to state.alerts.active[]
  
For each RESOLVE_ALERTS:
  - AlertService.resolveAlertsByTrigger(trigger)
  - Moves alerts to state.alerts.resolved[]
  - Creates resolution notification
  ↓
StateManager broadcasts updated state to clients
```

### Integration with StateManager

The StateManager needs to:

1. **Initialize AlertService and RuleEngine**:
```javascript
import { AlertService } from './services/AlertService.js';
import { RuleEngine } from './state/ruleEngine.js';
import { AllRules } from './state/allRules.js';

class StateManager {
  constructor() {
    this.alertService = new AlertService(this);
    this.ruleEngine = new RuleEngine(AllRules);
  }
}
```

2. **Evaluate rules on state updates**:
```javascript
updateState(newState) {
  // Apply state changes...
  
  // Evaluate rules
  const actions = this.ruleEngine.evaluate(this.appState);
  
  // Process alert actions
  const alertActions = actions.filter(a => 
    a.type === 'CREATE_ALERT' || a.type === 'RESOLVE_ALERTS'
  );
  
  if (alertActions.length > 0) {
    this.alertService.processAlertActions(alertActions);
  }
}
```

3. **Handle client alert commands**:
```javascript
// When client sends alert via relayConnectionAdapter.sendAlert()
handleCommand(serviceName, action, data) {
  if (serviceName === 'alert' && action === 'update') {
    this.alertService.createAlert(data);
  }
}
```

---

## Files Summary

**Restored to `compendiumnav2-server`**:
1. ✅ `src/services/AlertService.js` - Alert creation/management service
2. ✅ `src/state/alertRules.js` - Hardcoded system alert rules
3. ✅ `src/state/ruleEngine.js` - Generic rule evaluation engine
4. ✅ `src/state/allRules.js` - Combined rules registry

**Needs Configuration**:
- Update `allRules.js` to import from `./alertRules.js`
- Integrate with StateManager
- Add command handler for client-initiated alerts

