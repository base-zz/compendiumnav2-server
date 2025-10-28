import { stateData } from "./StateData.js";
import { UnitConversion } from "../shared/unitConversion.js";

function unwrapValue(entry) {
  if (entry === undefined || entry === null) {
    return null;
  }
  if (typeof entry === "object" && entry !== null && Object.prototype.hasOwnProperty.call(entry, "value")) {
    return entry.value;
  }
  return entry;
}

function getUserUnitPreferences() {
  const prefs = stateData?.userUnitPreferences;
  if (prefs && typeof prefs === "object" && Object.keys(prefs).length > 0) {
    return prefs;
  }
  const defaultPrefs = stateData?.convert?.defaultUnitPreferences;
  if (defaultPrefs) return defaultPrefs;
  return null;
}

function getTargetUnit(unitType) {
  const userPrefs = getUserUnitPreferences();
  if (userPrefs && Object.prototype.hasOwnProperty.call(userPrefs, unitType)) {
    return userPrefs[unitType];
  }
  return null;
}

function convertValue(value, sourceUnit, unitType) {
  if (typeof value !== "number") {
    return { value, sourceUnit: sourceUnit ?? null, targetUnit: null, convertedValue: value };
  }

  const targetUnit = getTargetUnit(unitType);
  if (!targetUnit || !sourceUnit || sourceUnit === targetUnit) {
    if (!targetUnit) {
      console.warn('[AIS] Missing target unit for type', unitType, 'with preferences:', getUserUnitPreferences());
    }
    return { value, sourceUnit: sourceUnit ?? null, targetUnit: targetUnit ?? null, convertedValue: value };
  }

  try {
    const convertedValue = UnitConversion.convert(value, sourceUnit, targetUnit);
    console.debug('[AIS] Converted value', {
      unitType,
      value,
      sourceUnit,
      targetUnit,
      convertedValue
    });
    return { value, sourceUnit, targetUnit, convertedValue };
  } catch (err) {
    console.error("[AIS] Failed to convert value", {
      value,
      sourceUnit,
      targetUnit,
      unitType,
      error: err,
    });
    return { value, sourceUnit, targetUnit, convertedValue: value };
  }
}

function attachConvertedMeasurements(entry, unitType, fallbackSourceUnit) {
  if (entry === null) return null;

  const measurement = extractMeasurement(entry, true);
  if (!measurement) return null;

  const sourceUnit = measurement?.meta?.units || fallbackSourceUnit || null;
  if (typeof measurement.value !== "number") {
    return measurement;
  }

  const converted = convertValue(measurement.value, sourceUnit, unitType);
  const convertedValue =
    converted && typeof converted === "object" && Object.prototype.hasOwnProperty.call(converted, "convertedValue")
      ? converted.convertedValue
      : converted;

  measurement.value = convertedValue;

  if (measurement.meta) {
    const targetUnit = converted?.targetUnit;
    if (targetUnit) {
      if (Object.prototype.hasOwnProperty.call(measurement.meta, "units")) {
        measurement.meta.units = targetUnit;
      }
    }
  }

  return measurement;
}

function extractMeasurement(entry, skipConversion = false) {
  if (entry === undefined || entry === null) {
    return null;
  }
  if (typeof entry !== "object" || entry === null) {
    return { value: entry };
  }

  const measurement = {
    value: unwrapValue(entry),
  };

  if (Object.prototype.hasOwnProperty.call(entry, "$source")) {
    measurement.source = entry.$source ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(entry, "timestamp")) {
    measurement.timestamp = entry.timestamp ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(entry, "pgn")) {
    measurement.pgn = entry.pgn ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(entry, "meta")) {
    measurement.meta = entry.meta ?? null;
  }

  if (skipConversion) {
    return measurement;
  }

  return measurement;
}

function extractDesignLength(designLengthEntry) {
  if (designLengthEntry === undefined || designLengthEntry === null) {
    return null;
  }

  const lengthDetails = {
    overall: null,
    hull: null,
    waterline: null,
    meta: null,
  };

  const isObject = typeof designLengthEntry === "object" && designLengthEntry !== null;
  const lengthValue = unwrapValue(designLengthEntry);

  if (isObject && Object.prototype.hasOwnProperty.call(designLengthEntry, "meta")) {
    lengthDetails.meta = designLengthEntry.meta ?? null;
  }

  if (lengthValue !== null) {
    if (typeof lengthValue === "object" && lengthValue !== null) {
      if (Object.prototype.hasOwnProperty.call(lengthValue, "overall")) {
        const overallEntry = lengthValue.overall ?? null;
        lengthDetails.overall = overallEntry;
        const overallNumeric = unwrapValue(overallEntry);
        if (typeof overallNumeric === "number") {
          const converted = convertValue(overallNumeric, "m", "length");
          const convertedValue =
            converted && typeof converted === "object" && Object.prototype.hasOwnProperty.call(converted, "convertedValue")
              ? converted.convertedValue
              : converted;
          lengthDetails.overall = convertedValue;
          if (lengthDetails.meta?.properties?.overall && converted?.targetUnit) {
            lengthDetails.meta.properties.overall.units = converted.targetUnit;
          }
        }
      }
      if (Object.prototype.hasOwnProperty.call(lengthValue, "hull")) {
        const hullEntry = lengthValue.hull ?? null;
        lengthDetails.hull = hullEntry;
        const hullNumeric = unwrapValue(hullEntry);
        if (typeof hullNumeric === "number") {
          const converted = convertValue(hullNumeric, "m", "length");
          const convertedValue =
            converted && typeof converted === "object" && Object.prototype.hasOwnProperty.call(converted, "convertedValue")
              ? converted.convertedValue
              : converted;
          lengthDetails.hull = convertedValue;
          if (lengthDetails.meta?.properties?.hull && converted?.targetUnit) {
            lengthDetails.meta.properties.hull.units = converted.targetUnit;
          }
        }
      }
      if (Object.prototype.hasOwnProperty.call(lengthValue, "waterline")) {
        const waterlineEntry = lengthValue.waterline ?? null;
        lengthDetails.waterline = waterlineEntry;
        const waterlineNumeric = unwrapValue(waterlineEntry);
        if (typeof waterlineNumeric === "number") {
          const converted = convertValue(waterlineNumeric, "m", "length");
          const convertedValue =
            converted && typeof converted === "object" && Object.prototype.hasOwnProperty.call(converted, "convertedValue")
              ? converted.convertedValue
              : converted;
          lengthDetails.waterline = convertedValue;
          if (lengthDetails.meta?.properties?.waterline && converted?.targetUnit) {
            lengthDetails.meta.properties.waterline.units = converted.targetUnit;
          }
        }
      }
    } else if (typeof lengthValue === "number") {
      const converted = convertValue(lengthValue, "m", "length");
      const convertedValue =
        converted && typeof converted === "object" && Object.prototype.hasOwnProperty.call(converted, "convertedValue")
          ? converted.convertedValue
          : converted;
      lengthDetails.overall = convertedValue;
      if (lengthDetails.meta?.properties?.overall && converted?.targetUnit) {
        lengthDetails.meta.properties.overall.units = converted.targetUnit;
      }
    }
  }

  if (isObject && Object.prototype.hasOwnProperty.call(designLengthEntry, "$source")) {
    lengthDetails.source = designLengthEntry.$source ?? null;
  }
  if (isObject && Object.prototype.hasOwnProperty.call(designLengthEntry, "timestamp")) {
    lengthDetails.timestamp = designLengthEntry.timestamp ?? null;
  }
  if (isObject && Object.prototype.hasOwnProperty.call(designLengthEntry, "pgn")) {
    lengthDetails.pgn = designLengthEntry.pgn ?? null;
  }

  return lengthDetails;
}

function extractBeam(designBeamEntry) {
  if (designBeamEntry === undefined || designBeamEntry === null) {
    return null;
  }

  const beamDetails = {
    value: unwrapValue(designBeamEntry),
  };

  if (typeof designBeamEntry === "object" && designBeamEntry !== null) {
    if (Object.prototype.hasOwnProperty.call(designBeamEntry, "$source")) {
      beamDetails.source = designBeamEntry.$source ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(designBeamEntry, "timestamp")) {
      beamDetails.timestamp = designBeamEntry.timestamp ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(designBeamEntry, "pgn")) {
      beamDetails.pgn = designBeamEntry.pgn ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(designBeamEntry, "meta")) {
      beamDetails.meta = designBeamEntry.meta ?? null;
    }
  }

  if (typeof beamDetails.value === "number") {
    const converted = convertValue(beamDetails.value, beamDetails.meta?.units || "m", "length");
    const convertedValue =
      converted && typeof converted === "object" && Object.prototype.hasOwnProperty.call(converted, "convertedValue")
        ? converted.convertedValue
        : converted;
    beamDetails.value = convertedValue;
    if (beamDetails.meta && converted?.targetUnit) {
      beamDetails.meta.units = converted.targetUnit;
    }
  }

  return beamDetails;
}

function extractShipType(vessel) {
  const designShipTypeEntry = vessel?.design?.aisShipType;
  const aisShipTypeEntry = vessel?.ais?.shipType;
  const entry = designShipTypeEntry ?? aisShipTypeEntry;

  if (entry === undefined || entry === null) {
    return { label: null, id: null, raw: null };
  }

  const shipTypeValue = unwrapValue(entry);
  const shipTypeResult = {
    label: null,
    id: null,
    raw: shipTypeValue,
  };

  if (shipTypeValue !== null && typeof shipTypeValue === "object") {
    if (Object.prototype.hasOwnProperty.call(shipTypeValue, "name")) {
      shipTypeResult.label = shipTypeValue.name ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(shipTypeValue, "id")) {
      shipTypeResult.id = shipTypeValue.id ?? null;
    }
  } else if (shipTypeValue !== null) {
    shipTypeResult.label = shipTypeValue;
    if (typeof shipTypeValue === "number") {
      shipTypeResult.id = shipTypeValue;
    }
  }

  return shipTypeResult;
}

// Extract and transform AIS targets from SignalK full data
export function extractAISTargetsFromSignalK(signalKData, selfMmsi) {
  // signalKData is expected to be the full vessels object (e.g., signalKData.vessels)
  // selfMmsi is the MMSI of the user's own vessel (from stateData.vessel.info.mmsi)
  if (!signalKData || typeof signalKData !== "object") return [];
  const aisTargets = [];
  for (const mmsi in signalKData) {
    if (!Object.prototype.hasOwnProperty.call(signalKData, mmsi)) continue;
    if (mmsi === "self" || mmsi === selfMmsi) continue; // skip self
    const vessel = signalKData[mmsi];
    if (!vessel) continue;

    const designSection = typeof vessel.design === "object" && vessel.design !== null ? vessel.design : null;
    const sensorsSection = typeof vessel.sensors === "object" && vessel.sensors !== null ? vessel.sensors : null;
    const sensorsAisSection = sensorsSection?.ais && typeof sensorsSection.ais === "object" ? sensorsSection.ais : null;
    const communicationSection = typeof vessel.communication === "object" && vessel.communication !== null ? vessel.communication : null;
    const aisSection = typeof vessel.ais === "object" && vessel.ais !== null ? vessel.ais : null;

    let nm = vessel?.name?.value ?? vessel?.name ?? null;
    if (typeof nm === "string") {
      nm = nm.replace(/\u0000/g, "");
    }

    const shipTypeInfo = extractShipType(vessel);
    const aisClassValue = unwrapValue(aisSection?.class) ?? unwrapValue(sensorsAisSection?.class);
    const navigationPosition = vessel?.navigation?.position ?? null;
    const positionValue = navigationPosition?.value ?? null;
    const navigationCourse = vessel?.navigation?.courseOverGroundTrue ?? null;
    const navigationSpeed = vessel?.navigation?.speedOverGround ?? null;
    const navigationHeading = vessel?.navigation?.headingTrue ?? null;

    const aisTarget = {
      mmsi: mmsi.split(":").pop(),
      name: nm,
      class: aisClassValue ?? null,
      shipType: shipTypeInfo.label,
      shipTypeId: shipTypeInfo.id,
      position: {
        latitude: positionValue?.latitude ?? null,
        longitude: positionValue?.longitude ?? null,
        altitude: positionValue?.altitude ?? null,
        timestamp: navigationPosition?.timestamp ?? null,
        source: navigationPosition?.$source ?? null,
        pgn: navigationPosition?.pgn ?? null,
      },
      cog: (() => {
        const raw = unwrapValue(navigationCourse);
        if (typeof raw !== "number") return raw ?? null;
        return convertValue(raw, "rad", "angle");
      })(),
      sog: (() => {
        const raw = unwrapValue(navigationSpeed);
        if (typeof raw !== "number") return raw ?? null;
        return convertValue(raw, "m/s", "speed");
      })(),
      heading: (() => {
        const raw = unwrapValue(navigationHeading);
        if (typeof raw !== "number") return raw ?? null;
        return convertValue(raw, "rad", "angle");
      })(),
      destination: unwrapValue(aisSection?.destination) ?? null,
      callsign: unwrapValue(communicationSection?.callsignVhf) ?? null,
      status: unwrapValue(aisSection?.navStatus) ?? null,
      eta: unwrapValue(aisSection?.eta) ?? null,
      design: {
        length: designSection?.length ?? null,
        beam: designSection?.beam ?? null,
        aisShipType: designSection?.aisShipType ?? null,
      },
      dimensions: {
        length: extractDesignLength(designSection?.length),
        beam: extractBeam(designSection?.beam),
      },
      sensors: {
        ais: {
          fromBow: attachConvertedMeasurements(
            sensorsAisSection?.fromBow,
            "length",
            "m"
          ),
          fromCenter: attachConvertedMeasurements(
            sensorsAisSection?.fromCenter,
            "length",
            "m"
          ),
          class: extractMeasurement(sensorsAisSection?.class),
        },
      },
      communication: communicationSection ?? null,
      navigationDetails: {
        speedOverGround: attachConvertedMeasurements(
          navigationSpeed,
          "speed",
          "m/s"
        ),
        courseOverGroundTrue: attachConvertedMeasurements(
          navigationCourse,
          "angle",
          "rad"
        ),
        headingTrue: attachConvertedMeasurements(
          navigationHeading,
          "angle",
          "rad"
        ),
      },
    };

    if (shipTypeInfo.raw !== null) {
      aisTarget.shipTypeDetails = shipTypeInfo.raw;
    }

    aisTargets.push(aisTarget);
  }
  return aisTargets;
}

export async function updateAISTargetsFromSignalK(fullSignalKData, stateData) {
  // fullSignalKData should be the root SignalK document (with .vessels)
  const selfMmsi = stateData.vessel?.info?.mmsi;
  const aisTargets = extractAISTargetsFromSignalK(fullSignalKData.vessels, selfMmsi);
  stateData.aisTargets = aisTargets; // Update top-level aisTargets property
  console.log(`[AIS] Updated ${aisTargets.length} AIS targets from SignalK`);
}
