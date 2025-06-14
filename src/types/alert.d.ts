declare module '../../../shared/alertDatum' {
  export const BASE_ALERT_DATUM: any;
}

declare module './PushTokenStore' {
  export const pushTokenStore: any;
}

declare module 'debug' {
  const debug: (namespace: string) => (...args: any[]) => void;
  export default debug;
}

/**
 * Alert level type
 * @typedef {'info'|'warning'|'error'|'critical'} AlertLevel
 */
export type AlertLevel = 'info' | 'warning' | 'error' | 'critical';

declare module 'alert-types' {
  /**
   * Alert status type
   */
  export type AlertStatus = 'active' | 'acknowledged' | 'resolved' | 'expired';

  /**
   * Alert interface
   */
  export interface Alert {
    id: string;
    type: string;
    category?: string;
    source?: string;
    level: AlertLevel;
    label: string;
    message: string;
    timestamp: string;
    acknowledged: boolean;
    status: AlertStatus;
    autoResolvable?: boolean;
    autoExpire?: boolean;
    expiresIn?: number;
    trigger?: string;
    data?: Record<string, any>;
    silent?: boolean;
    expiresAt?: string;
    resolvedAt?: string;
    resolvedBy?: string;
    resolutionMessage?: string;
  }

  /**
   * Resolution data type
   */
  export interface ResolutionData {
    message?: string;
    data?: Record<string, any>;
    distance?: number | string;
    units?: string;
    warningRadius?: number | string;
  }

  /**
   * State manager interface
   */
  export interface StateManager {
    appState: {
      alerts: {
        active: Alert[];
        acknowledged: Alert[];
        resolved: Alert[];
      };
    };
    emit: (event: string, ...args: any[]) => void;
    on: (event: string, listener: (...args: any[]) => void) => void;
    off: (event: string, listener: (...args: any[]) => void) => void;
    getState: () => any;
    updateState: (updater: (state: any) => any) => void;
  }
}

// Global type declarations for JSDoc
/**
 * @typedef {'info'|'warning'|'error'|'critical'} AlertLevel
 * @typedef {import('alert-types').Alert} Alert
 * @typedef {import('alert-types').AlertStatus} AlertStatus
 * @typedef {import('alert-types').ResolutionData} ResolutionData
 * @typedef {import('alert-types').StateManager} StateManager
 */

type AlertState = {
  active: Alert[];
  resolved: Alert[];
};

type AppState = {
  alerts: AlertState;
  // Add other app state properties as needed
};

type StateManager = {
  appState: AppState;
  // Add other state manager methods as needed
};

export {};
