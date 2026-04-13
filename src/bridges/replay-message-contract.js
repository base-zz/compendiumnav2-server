export const REPLAY_INPUT_SUBJECTS = {
  STATE_BRIDGE: "state:bridge",
  STATE_FORECAST: "state:forecast",
  STATE_TIDES: "state:tides",
};

export const REPLAY_COMMAND_SUBJECTS = {
  ROOT: "commands",
  SPEED: "commands.speed",
  STOP: "commands.stop",
  START: "commands.start",
  STATUS: "commands.status",
  HELP: "commands.help",
};

export const BRIDGES_UI_SUBJECTS = {
  HEADER: "ui.bridges.header",
  NEXT_BRIDGE: "ui.bridges.next_bridge",
  ALERT: "ui.bridges.alert",
  NOTIFICATION: "ui.bridges.notification",
};

export function validateReplayToBridgesConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("Replay message config is required");
  }

  if (!Object.prototype.hasOwnProperty.call(config, "natsUrl") || typeof config.natsUrl !== "string" || !config.natsUrl.trim()) {
    throw new Error("Replay message config requires natsUrl");
  }

  if (!Object.prototype.hasOwnProperty.call(config, "bridgeInputSubject") || typeof config.bridgeInputSubject !== "string" || !config.bridgeInputSubject.trim()) {
    throw new Error("Replay message config requires bridgeInputSubject");
  }

  if (!Object.prototype.hasOwnProperty.call(config, "headerOutputSubject") || typeof config.headerOutputSubject !== "string" || !config.headerOutputSubject.trim()) {
    throw new Error("Replay message config requires headerOutputSubject");
  }

  if (!Object.prototype.hasOwnProperty.call(config, "nextBridgeOutputSubject") || typeof config.nextBridgeOutputSubject !== "string" || !config.nextBridgeOutputSubject.trim()) {
    throw new Error("Replay message config requires nextBridgeOutputSubject");
  }

  if (!Object.prototype.hasOwnProperty.call(config, "alertOutputSubject") || typeof config.alertOutputSubject !== "string" || !config.alertOutputSubject.trim()) {
    throw new Error("Replay message config requires alertOutputSubject");
  }

  if (!Object.prototype.hasOwnProperty.call(config, "notificationOutputSubject") || typeof config.notificationOutputSubject !== "string" || !config.notificationOutputSubject.trim()) {
    throw new Error("Replay message config requires notificationOutputSubject");
  }

  return config;
}
