import BaseService from "./BaseService.js";
import { connect, StringCodec } from "nats";
import { getStateManager } from "../relay/core/state/StateManager.js";

export class StateNatsBroadcastService extends BaseService {
  constructor(options = {}) {
    super("state-nats-broadcast", "continuous");

    this.subjectPrefix = options.subjectPrefix;
    this.broadcastKeys = options.broadcastKeys;
    this.fullPatchSubject = options.fullPatchSubject;
    this.natsUrl = options.natsUrl;
    this.serverName = options.serverName;

    this._connection = null;
    this._codec = StringCodec();
    this._stateManager = null;
    this._statePatchHandler = null;
  }

  async start() {
    if (this.isRunning) {
      return;
    }

    if (!this.natsUrl) {
      throw new Error(
        "StateNatsBroadcastService requires NATS_URL to be defined"
      );
    }

    if (!this.subjectPrefix) {
      throw new Error(
        "StateNatsBroadcastService requires NATS_STATE_SUBJECT_PREFIX to be defined"
      );
    }

    if (!Array.isArray(this.broadcastKeys) || this.broadcastKeys.length === 0) {
      throw new Error(
        "StateNatsBroadcastService requires NATS_BROADCAST_KEYS to be defined"
      );
    }

    this._stateManager = getStateManager();
    if (!this._stateManager) {
      throw new Error(
        "StateNatsBroadcastService requires a StateManager instance"
      );
    }

    const connectionConfig = {
      servers: this.natsUrl,
    };
    if (this.serverName) {
      connectionConfig.name = this.serverName;
    }

    this._connection = await connect(connectionConfig);

    this._statePatchHandler = (event) => {
      if (!event || !this._connection) {
        return;
      }

      const payload = {
        type: "state:patch",
        data: event.data,
        boatId: event.boatId,
        timestamp: event.timestamp,
      };

      const patches = Array.isArray(event.data) ? event.data : [];
      const touchedKeys = new Set();

      for (const patch of patches) {
        if (!patch || typeof patch.path !== "string") {
          continue;
        }

        const topLevelKey = patch.path.split("/")[1];
        if (!topLevelKey) {
          continue;
        }

        if (!this.broadcastKeys.includes(topLevelKey)) {
          continue;
        }

        touchedKeys.add(topLevelKey);
      }

      for (const key of touchedKeys) {
        const subject = `${this.subjectPrefix}.${key}`;
        this._connection.publish(subject, this._codec.encode(JSON.stringify(payload)));
      }

      if (this.fullPatchSubject) {
        this._connection.publish(this.fullPatchSubject, this._codec.encode(JSON.stringify(payload)));
      }
    };

    this._stateManager.on("state:patch", this._statePatchHandler);

    await super.start();
    this.log(
      `Broadcasting state patches to NATS subjects '${this.subjectPrefix}.<key>' via ${this.natsUrl}`
    );
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    if (this._stateManager && this._statePatchHandler) {
      this._stateManager.off("state:patch", this._statePatchHandler);
    }

    this._statePatchHandler = null;
    this._stateManager = null;

    if (this._connection) {
      await this._connection.close();
      this._connection = null;
    }

    await super.stop();
  }
}

export default StateNatsBroadcastService;
