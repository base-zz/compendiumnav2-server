function setDeep(obj, path, value) {
  const keys = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let cur = obj;
  let parent = null;
  let parentKey = null;

  while (keys.length > 1) {
    const key = keys.shift();
    const keyAsNum = Number(key);
    const isArrayKey = Number.isInteger(keyAsNum) && key === String(keyAsNum);

    parent = cur;
    parentKey = key;

    if (isArrayKey) {
      if (!Array.isArray(parent[parentKey])) {
        parent[parentKey] = []; // Preserve reference by assigning to parent
      }
      cur = parent[parentKey];
      if (cur[keyAsNum] === undefined) {
        cur[keyAsNum] = {};
      }
      cur = cur[keyAsNum];
    } else {
      if (
        typeof cur[key] !== "object" ||
        cur[key] === null ||
        Array.isArray(cur[key])
      ) {
        cur[key] = {};
      }
      cur = cur[key];
    }
  }

  const finalKey = keys[0];
  const finalKeyAsNum = Number(finalKey);
  const isFinalArrayKey =
    Number.isInteger(finalKeyAsNum) && finalKey === String(finalKeyAsNum);

  if (isFinalArrayKey && Array.isArray(cur)) {
    cur[finalKeyAsNum] = value;
  } else {
    cur[finalKey] = value;
  }

  return obj;
}

import { createStateDataModel } from '../../shared/stateDataModel.js';
import { UNIT_PRESETS } from '../../shared/unitPreferences.js';

// Create the base state using the shared model with imperial units as default
// This matches the client-side default and ensures consistency
const baseState = createStateDataModel(UNIT_PRESETS.IMPERIAL);

export const stateData = {
  ...baseState,
  convert: {
    // Length/Distance
    mToFeet(m) {
      return m !== null ? Math.round(m * 3.28084 * 10) / 10 : null;
    },
    mToNauticalMiles(m) {
      return m !== null ? Math.round((m / 1852) * 10) / 10 : null;
    },

    // Speed (1 decimal)
    mpsToKnots(mps) {
      return mps !== null ? Math.round(mps * 1.94384 * 10) / 10 : null;
    },

    // Angle (1 decimal for degrees)
    radToDeg(rad) {
      return rad !== null ? Math.round(rad * (180 / Math.PI) * 10) / 10 : null;
    },

    // Temperature (1 decimal)
    cToF(c) {
      return c !== null ? Math.round(((c * 9) / 5 + 32) * 10) / 10 : null;
    },

    // Pressure (1 decimal)
    paToHpa(pa) {
      return pa !== null ? Math.round((pa / 100) * 10) / 10 : null;
    },
    paToInHg(pa) {
      return pa !== null ? Math.round((pa / 3386.39) * 10) / 10 : null;
    },

    // Volume (1 decimal)
    litersToGallons(l) {
      return l !== null ? Math.round(l * 0.264172 * 10) / 10 : null;
    },

    updateAllDerivedValues() {
      this.convertPositionValues();
      this.convertCourseValues();
      this.convertSpeedValues();
      this.convertWindValues();
      this.convertAnchorValues();
      this.convertDepthValues(); // Add this line
    },

    convertAnchorValues() {
      const convertAnchorLocation = (location) => {
        if (!location) return;
        if (location.distancesFromCurrent.value !== null) {
          location.distancesFromCurrent.nauticalMiles = this.mToNauticalMiles(
            location.distancesFromCurrent.value
          );
          location.distancesFromCurrent.feet = this.mToFeet(
            location.distancesFromCurrent.value
          );
        }

        if (location.distancesFromDrop.value !== null) {
          location.distancesFromDrop.nauticalMiles = this.mToNauticalMiles(
            location.distancesFromDrop.value
          );
          location.distancesFromDrop.feet = this.mToFeet(
            location.distancesFromDrop.value
          );
        }
      };

      if (this.anchor) {
        convertAnchorLocation(this.anchor.anchorDropLocation);
        convertAnchorLocation(this.anchor.anchorLocation);
      }
    },

    convertCourseValues() {
      const course = stateData.navigation?.course;
      if (!course) return;

      // COG
      if (course.cog.value !== null) {
        course.cog.degrees = stateData.convert.radToDeg(course.cog.value);
      }

      // Heading
      if (course.heading.magnetic.value !== null) {
        // Only convert to degrees if the units are not already in degrees
        if (course.heading.magnetic.units !== 'deg') {
          course.heading.magnetic.degrees = stateData.convert.radToDeg(
            course.heading.magnetic.value
          );
        } else {
          // If already in degrees, don't add a separate degrees field
          delete course.heading.magnetic.degrees;
        }
      }
      if (course.heading.true.value !== null) {
        // Only convert to degrees if the units are not already in degrees
        if (course.heading.true.units !== 'deg') {
          course.heading.true.degrees = stateData.convert.radToDeg(
            course.heading.true.value
          );
        } else {
          // If already in degrees, don't add a separate degrees field
          delete course.heading.true.degrees;
        }
      }

      // Rate of turn
      if (course.rateOfTurn.value !== null) {
        course.rateOfTurn.degPerMin =
          Math.round(
            stateData.convert.radToDeg(course.rateOfTurn.value) * 60 * 10
          ) / 10;
      }
    },

    convertDepthValues() {
      // No conversion needed - use the canonical data model values directly
      // The state data model is configured to use imperial units by default
      // All depth measurements should already be in feet
      return;
    },

    convertSpeedValues() {
      const speed = stateData.navigation?.speed;
      if (!speed) return;

      if (speed.sog.value !== null) {
        speed.sog.knots = stateData.convert.mpsToKnots(speed.sog.value);
      }

      if (speed.stw.value !== null) {
        speed.stw.knots = stateData.convert.mpsToKnots(speed.stw.value);
      }
    },

    convertPositionValues() {
      const pos = stateData.navigation?.position;
      if (!pos) return;
    },

    convertWindValues() {
      const wind = stateData.navigation?.wind;
      if (!wind) return;

      // Apparent wind
      if (wind.apparent?.angle?.value !== undefined) {
        wind.apparent.angle.degrees = stateData.convert.radToDeg(
          wind.apparent.angle.value
        );
        wind.apparent.angle.side =
          wind.apparent.angle.value >= 0 ? "starboard" : "port";

        if (wind.apparent?.speed?.value !== undefined) {
          wind.apparent.speed.knots = stateData.convert.mpsToKnots(
            wind.apparent.speed.value
          );
        }
      }

      // True wind
      if (wind.true?.angle?.value !== undefined) {
        wind.true.angle.degrees = stateData.convert.radToDeg(
          wind.true.angle.value
        );
        wind.true.angle.side =
          wind.true.angle.value >= 0 ? "starboard" : "port";

        if (wind.true?.speed?.value !== undefined) {
          wind.true.speed.knots = stateData.convert.mpsToKnots(
            wind.true.speed.value
          );
        }
      }
    },
  }, // Close the methods object

  batchUpdate(updates) {
    // First ensure all required structures exist
    this.ensureDataStructures();

    // Process updates
    if (Array.isArray(updates)) {
      updates.forEach(({ path, value }) => {
        try {
          setDeep(this, path, value);
        } catch (error) {
          console.warn(`Failed to update path ${path}:`, error);
        }
      });
    } else if (typeof updates === "object") {
      Object.entries(updates).forEach(([path, value]) => {
        try {
          setDeep(this, path, value);
        } catch (error) {
          console.warn(`Failed to update path ${path}:`, error);
        }
      });
    }
    return true;
  },

  ensureDataStructures() {
    // Depth measurements
    const depthMeasurements = ["belowTransducer", "belowKeel", "belowSurface"];
    depthMeasurements.forEach((key) => {
      if (!this.navigation.depth[key]) {
        this.navigation.depth[key] = { value: null, units: UNIT_PRESETS.IMPERIAL.length };
      }
      if (!this.navigation.depth[key].feet) {
        this.navigation.depth[key].feet = { value: null };
      }
    });
  },

  get state() {
    return structuredClone({
      navigation: this.navigation,
      environment: this.environment,
      vessel: this.vessel,
      anchor: this.anchor,
      aisTargets: this.aisTargets,
      alerts: this.alerts,
    });
  },
};
