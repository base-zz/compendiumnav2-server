/**
 * Navigation rules for the state manager to determine throttling profiles
 * 
 * These rules control data synchronization rates based on the vessel's
 * current navigation status.
 */
export const NavigationRules = [
  // Rule for vessel underway at high speed
  {
    name: 'High Speed Navigation',
    condition: (state) => state.speed > 10 && state.navigationStatus === 'UNDERWAY',
    action: {
      type: 'SET_SYNC_PROFILE',
      config: {
        navigation: { 
          base: 1000, // Faster updates for navigation data
          multipliers: { 
            CRITICAL: 0.1, // Very fast for critical data
            HIGH: 0.5,     // Fast for high priority
            NORMAL: 1,     // Normal speed
            LOW: 2         // Slower for low priority
          }
        },
        depth: { base: 3000 }, // More frequent depth updates
        ais: { base: 5000 }    // More frequent AIS updates
      }
    }
  },
  
  // Rule for vessel at anchor
  {
    name: 'At Anchor',
    condition: (state) => state.anchorStatus === 'DOWN',
    action: {
      type: 'SET_SYNC_PROFILE',
      config: {
        navigation: { 
          base: 10000, // Slower updates for navigation data
          multipliers: { 
            CRITICAL: 0.2, // Still relatively fast for critical data
            HIGH: 0.5,     // Medium speed for high priority
            NORMAL: 1,     // Normal speed
            LOW: 5         // Very slow for low priority
          }
        },
        anchor: { base: 2000 }, // More frequent anchor updates
        depth: { base: 30000 }, // Less frequent depth updates
        ais: { base: 20000 }    // Less frequent AIS updates
      }
    }
  },
  
  // Default rule for normal operation
  {
    name: 'Default Operation',
    condition: () => true, // Always matches as a fallback
    action: {
      type: 'SET_SYNC_PROFILE',
      config: {
        navigation: { 
          base: 5000, 
          multipliers: { 
            CRITICAL: 0.2, 
            HIGH: 0.8,
            NORMAL: 1,
            LOW: 3
          }
        },
        anchor: { base: 10000 },
        depth: { base: 15000 },
        ais: { base: 10000 }
      }
    }
  }
];
