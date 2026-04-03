import fs from "node:fs/promises";
import process from "node:process";
import { connect, StringCodec } from "nats";

function parseArgs(argv) {
  const args = {};

  for (const token of argv) {
    if (!token.startsWith("--")) {
      continue;
    }

    const equalsIndex = token.indexOf("=");
    if (equalsIndex === -1) {
      throw new Error(`Invalid argument '${token}'. Use --name=value format.`);
    }

    const key = token.slice(2, equalsIndex).trim();
    const value = token.slice(equalsIndex + 1).trim();

    if (!key) {
      throw new Error(`Invalid argument '${token}'. Argument name is empty.`);
    }

    if (!value) {
      throw new Error(`Invalid argument '${token}'. Argument value is empty.`);
    }

    args[key] = value;
  }

  const requiredKeys = [
    "file",
    "nats-url",
    "subject",
    "payload-mode",
    "interval-ms",
    "loop",
    "boat-id",
    "source",
  ];

  for (const key of requiredKeys) {
    if (!(key in args)) {
      throw new Error(`Missing required argument --${key}=...`);
    }
  }

  return args;
}

function parseLoopValue(rawValue) {
  if (rawValue === "true") {
    return true;
  }

  if (rawValue === "false") {
    return false;
  }

  throw new Error("--loop must be 'true' or 'false'");
}

function parseIntervalMs(rawValue) {
  const value = Number(rawValue);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("--interval-ms must be a positive number");
  }

  return value;
}

function parsePayloadMode(rawValue) {
  if (rawValue === "patch") {
    return rawValue;
  }

  if (rawValue === "position") {
    return rawValue;
  }

  throw new Error("--payload-mode must be 'patch' or 'position'");
}

function extractPointsFromGpx(xmlText) {
  const pointPattern = /<(trkpt|rtept)\s+([^>]*?)\/?>(?:.*?<\/\1>)?/g;
  const attrPattern = /(\w+)="([^"]*)"/g;
  const points = [];

  let pointMatch = pointPattern.exec(xmlText);
  while (pointMatch) {
    const attrsText = pointMatch[2];
    const attrs = {};

    let attrMatch = attrPattern.exec(attrsText);
    while (attrMatch) {
      attrs[attrMatch[1]] = attrMatch[2];
      attrMatch = attrPattern.exec(attrsText);
    }

    const latitude = Number(attrs.lat);
    const longitude = Number(attrs.lon);

    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      points.push({ latitude, longitude });
    }

    pointMatch = pointPattern.exec(xmlText);
  }

  if (points.length === 0) {
    throw new Error("No GPX points found. Expected <trkpt> or <rtept> with lat/lon attributes.");
  }

  return points;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function publishReplay({
  points,
  natsUrl,
  subject,
  payloadMode,
  intervalMs,
  loop,
  boatId,
  source,
}) {
  const nc = await connect({ servers: natsUrl });
  const codec = StringCodec();

  let stopRequested = false;
  const stopHandler = async () => {
    stopRequested = true;
    await nc.close();
    process.exit(0);
  };

  process.on("SIGINT", stopHandler);
  process.on("SIGTERM", stopHandler);

  let sequence = 0;

  do {
    for (const point of points) {
      if (stopRequested) {
        return;
      }

      const timestamp = Date.now();
      const payload = payloadMode === "patch"
        ? {
            type: "state:patch",
            data: [
              {
                op: "replace",
                path: "/position/gpxSim",
                value: {
                  latitude: point.latitude,
                  longitude: point.longitude,
                  timestamp,
                  source,
                },
              },
            ],
            boatId,
            timestamp,
            sequence,
          }
        : {
            type: "state:position",
            boatId,
            timestamp,
            sequence,
            source,
            position: {
              latitude: point.latitude,
              longitude: point.longitude,
            },
          };

      nc.publish(subject, codec.encode(JSON.stringify(payload)));
      sequence += 1;

      console.log(
        `published seq=${sequence} subject=${subject} lat=${point.latitude} lon=${point.longitude}`
      );

      await delay(intervalMs);
    }
  } while (loop);

  await nc.flush();
  await nc.close();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const filePath = args["file"];
  const natsUrl = args["nats-url"];
  const subject = args["subject"];
  const payloadMode = parsePayloadMode(args["payload-mode"]);
  const intervalMs = parseIntervalMs(args["interval-ms"]);
  const loop = parseLoopValue(args["loop"]);
  const boatId = args["boat-id"];
  const source = args["source"];

  const xmlText = await fs.readFile(filePath, "utf8");
  const points = extractPointsFromGpx(xmlText);

  console.log(`loaded ${points.length} points from ${filePath}`);
  await publishReplay({
    points,
    natsUrl,
    subject,
    payloadMode,
    intervalMs,
    loop,
    boatId,
    source,
  });
}

main().catch((error) => {
  console.error("gpx replay failed:", error.message);
  process.exit(1);
});
