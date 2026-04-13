export const NATS_SUBJECTS = {
  INPUT: {
    BRIDGE: "state:bridge",
    FORECAST: "state:forecast",
    TIDES: "state:tides",
  },
  UI: {
    HEADER: "ui.bridges.header",
    NEXT_BRIDGE: "ui.bridges.next_bridge",
    ALERT: "ui.bridges.alert",
    NOTIFICATION: "ui.bridges.notification",
  },
  COMMANDS: {
    SET_SPEED: "commands.speed",
  },
};

export const MESSAGE_VERSION = "v1";

export function createMessageCodec(natsJSONCodec) {
  return {
    encode: (data) =>
      natsJSONCodec.encode({
        v: MESSAGE_VERSION,
        ts: Date.now(),
        data,
      }),
    decode: (msg) => {
      const decoded = natsJSONCodec.decode(msg);
      return decoded?.data || decoded;
    },
  };
}
