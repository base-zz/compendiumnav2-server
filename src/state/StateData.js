import { createStateDataModel } from '../shared/stateDataModel.js';
import { UNIT_PRESETS } from '../shared/unitPreferences.js';
import { UnitConversion } from '../shared/unitConversion.js';

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



// Create the base state using the shared model with imperial units as default
// This matches the client-side default and ensures consistency
const baseState = createStateDataModel(UNIT_PRESETS.IMPERIAL);

export const stateData = {
  ...baseState,
  _lastWindCalcInputs: {
    apparentSpeed: null,
    apparentAngle: null,
    heading: null,
    boatSpeed: null
  },
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
      this.convertDepthValues();
      // this.convertMarineValues();
    },
    
    // Convert marine data values
    convertMarineValues() {
      const { current, tides, forecast } = stateData.state() || {};
      
      // Convert current values
      if (current) {
        // Sea level and wave heights
        ['seaLevelHeightMsl', 'waveHeight', 'windWaveHeight'].forEach(field => {
          if (current[field]?.value !== null && current[field]?.value !== undefined) {
            current[field].feet = this.mToFeet(current[field].value);
            current[field].nauticalMiles = this.mToNauticalMiles(current[field].value);
          }
        });
        
        // Convert directions from radians to degrees if needed
        ['waveDirection', 'windWaveDirection'].forEach(field => {
          if (current[field]?.value !== null && current[field]?.value !== undefined) {
            current[field].degrees = this.radToDeg(current[field].value);
          }
        });
      }
      
      // Convert tide heights
      if (tides) {
        ['nextHigh', 'nextLow'].forEach(tide => {
          if (tides[tide]?.height?.value !== null && tides[tide]?.height?.value !== undefined) {
            tides[tide].height.feet = this.mToFeet(tides[tide].height.value);
            tides[tide].height.nauticalMiles = this.mToNauticalMiles(tides[tide].height.value);
          }
        });
      }
      
      // Convert forecast values
      if (forecast) {
        // Convert sea level and wave heights
        ['seaLevelHeightMsl', 'waveHeight', 'windWaveHeight'].forEach(field => {
          if (Array.isArray(forecast[field])) {
            forecast[`${field}Feet`] = forecast[field].map(val => val !== null ? this.mToFeet(val) : null);
            forecast[`${field}NauticalMiles`] = forecast[field].map(val => val !== null ? this.mToNauticalMiles(val) : null);
          }
        });
        
        // Convert directions from radians to degrees if needed
        ['waveDirection', 'windWaveDirection'].forEach(field => {
          if (Array.isArray(forecast[field])) {
            forecast[`${field}Degrees`] = forecast[field].map(val => val !== null ? this.radToDeg(val) : null);
          }
        });
      }
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

      const toSignedRadians = (angle) => {
        if (angle === null || angle === undefined) {
          return null;
        }
        const TWO_PI = Math.PI * 2;
        const normalized = ((angle % TWO_PI) + TWO_PI) % TWO_PI;
        return normalized > Math.PI ? normalized - TWO_PI : normalized;
      };

      const unitPrefs = stateData.userUnitPreferences || UNIT_PRESETS.IMPERIAL;
      const defaultSpeedUnit = unitPrefs.speed || UNIT_PRESETS.IMPERIAL.speed;
      const defaultAngleUnit = unitPrefs.angle || UNIT_PRESETS.IMPERIAL.angle;

      const ensureUnits = (node, fallbackUnit) => {
        if (!node) return fallbackUnit;
        if (!node.units) {
          node.units = fallbackUnit;
        }
        return node.units;
      };

      const convertToBase = (value, units) => {
        if (value === null || value === undefined || !units) return null;
        return UnitConversion.convertToBaseUnit(value, units);
      };

      const convertFromBase = (value, units) => {
        if (value === null || value === undefined || !units) return null;
        return UnitConversion.convertFromBaseUnit(value, units);
      };

      const apparentSpeedUnits = ensureUnits(wind.apparent?.speed, defaultSpeedUnit);
      const apparentAngleUnits = ensureUnits(wind.apparent?.angle, defaultAngleUnit);
      const trueSpeedUnits = ensureUnits(wind.true?.speed, defaultSpeedUnit);
      const trueAngleUnits = ensureUnits(wind.true?.angle, defaultAngleUnit);
      const trueDirectionUnits = ensureUnits(wind.true?.direction, defaultAngleUnit);

      // Get current inputs for true wind calculation
      const headingNode = stateData.navigation?.course?.heading?.true;
      const headingUnits = ensureUnits(headingNode, defaultAngleUnit);
      const stwNode = stateData.navigation?.speed?.stw;
      const sogNode = stateData.navigation?.speed?.sog;
      const stwUnits = ensureUnits(stwNode, defaultSpeedUnit);
      const sogUnits = ensureUnits(sogNode, defaultSpeedUnit);

      const apparentSpeedBase = convertToBase(wind.apparent?.speed?.value, apparentSpeedUnits);
      const apparentAngleBase = convertToBase(wind.apparent?.angle?.value, apparentAngleUnits);
      const headingBase = convertToBase(headingNode?.value, headingUnits);
      const stwBase = convertToBase(stwNode?.value, stwUnits);
      const sogBase = convertToBase(sogNode?.value, sogUnits);
      const boatSpeedBase = stwBase !== null ? stwBase : (sogBase !== null ? sogBase : 0);
      

      // Check if inputs have changed since last calculation
      const inputsChanged = 
        stateData._lastWindCalcInputs.apparentSpeed !== apparentSpeedBase ||
        stateData._lastWindCalcInputs.apparentAngle !== apparentAngleBase ||
        stateData._lastWindCalcInputs.heading !== headingBase ||
        stateData._lastWindCalcInputs.boatSpeed !== boatSpeedBase;

      // Apparent wind derived values (always update these)
      if (wind.apparent?.angle?.value !== undefined && wind.apparent.angle.value !== null) {
        if (apparentAngleBase !== null) {
          wind.apparent.angle.degrees = convertFromBase(apparentAngleBase, 'deg');
          wind.apparent.angle.side = apparentAngleBase >= 0 ? "starboard" : "port";
        } else {
          wind.apparent.angle.degrees = null;
          wind.apparent.angle.side = null;
        }
      } else if (wind.apparent?.angle) {
        wind.apparent.angle.degrees = null;
        wind.apparent.angle.side = null;
      }

      if (wind.apparent?.speed?.value !== undefined && wind.apparent.speed.value !== null) {
        const apparentKnots = UnitConversion.convert(
          wind.apparent.speed.value,
          apparentSpeedUnits,
          'kts'
        );
        wind.apparent.speed.knots = apparentKnots;
      } else if (wind.apparent?.speed) {
        wind.apparent.speed.knots = null;
      }

      // Only recalculate true wind if inputs have changed
      if (!inputsChanged) {
        return;
      }

      // Store current inputs for next comparison
      stateData._lastWindCalcInputs.apparentSpeed = apparentSpeedBase;
      stateData._lastWindCalcInputs.apparentAngle = apparentAngleBase;
      stateData._lastWindCalcInputs.heading = headingBase;
      stateData._lastWindCalcInputs.boatSpeed = boatSpeedBase;

      // True wind calculation

      // if (apparentSpeedBase !== null || apparentAngleBase !== null || headingBase !== null) {
      //   console.debug('[StateData] True wind inputs', {
      //     apparentSpeedRaw: wind.apparent?.speed?.value ?? null,
      //     apparentSpeedUnits,
      //     apparentSpeedBase,
      //     apparentAngleRaw: wind.apparent?.angle?.value ?? null,
      //     apparentAngleUnits,
      //     apparentAngleBase,
      //     headingRaw: headingNode?.value ?? null,
      //     headingUnits,
      //     headingBase,
      //     stwRaw: stwNode?.value ?? null,
      //     stwUnits,
      //     stwBase,
      //     sogRaw: sogNode?.value ?? null,
      //     sogUnits,
      //     sogBase
      //   });
      // }

      if (
        apparentSpeedBase !== null &&
        apparentAngleBase !== null &&
        headingBase !== null
      ) {
        let trueWindAngleBase;
        let trueWindSpeedBase;
        
        // When boat speed is very low (< 0.1 m/s or ~0.2 knots), 
        // true wind equals apparent wind
        if (boatSpeedBase < 0.1) {
          trueWindAngleBase = apparentAngleBase;
          trueWindSpeedBase = apparentSpeedBase;
        } else {
          // Normal true wind calculation when moving
          const numerator = apparentSpeedBase * Math.sin(apparentAngleBase);
          const denominator = apparentSpeedBase * Math.cos(apparentAngleBase) - boatSpeedBase;
          trueWindAngleBase = toSignedRadians(Math.atan2(numerator, denominator));

          const speedSquared =
            apparentSpeedBase * apparentSpeedBase +
            boatSpeedBase * boatSpeedBase -
            2 * apparentSpeedBase * boatSpeedBase * Math.cos(apparentAngleBase);
          trueWindSpeedBase = Math.sqrt(Math.max(0, speedSquared));
        }
        
        const trueWindDirectionBase = UnitConversion.normalizeRadians(headingBase + trueWindAngleBase);

        // console.debug('[StateData] True wind results', {
        //   boatSpeedBase,
        //   apparentSpeedBase,
        //   apparentAngleBase,
        //   numerator,
        //   denominator,
        //   trueWindSpeedBase,
        //   trueWindAngleBase,
        //   trueWindDirectionBase
        // });

        if (wind.true?.speed) {
          const trueWindSpeedValue = convertFromBase(trueWindSpeedBase, trueSpeedUnits);
          wind.true.speed.value = trueWindSpeedValue;
          wind.true.speed.knots = trueWindSpeedValue !== null
            ? UnitConversion.convert(trueWindSpeedValue, trueSpeedUnits, 'kts')
            : null;
        }

        if (wind.true?.angle) {
          wind.true.angle.value = convertFromBase(trueWindAngleBase, trueAngleUnits);
          wind.true.angle.degrees = convertFromBase(trueWindAngleBase, 'deg');
          wind.true.angle.side = trueWindAngleBase >= 0 ? "starboard" : "port";
        }

        if (wind.true?.direction) {
          wind.true.direction.value = convertFromBase(trueWindDirectionBase, trueDirectionUnits);
          wind.true.direction.degrees = convertFromBase(trueWindDirectionBase, 'deg');
        }
      } else {
        if (wind.true?.speed) {
          wind.true.speed.value = null;
          wind.true.speed.knots = null;
        }
        if (wind.true?.angle) {
          wind.true.angle.value = null;
          wind.true.angle.degrees = null;
          wind.true.angle.side = null;
        }
        if (wind.true?.direction) {
          wind.true.direction.value = null;
          wind.true.direction.degrees = null;
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
    // Return direct references - no cloning
    // The properties exist on this object from the spread of baseState
    return {
      position: this.position,
      navigation: this.navigation,
      environment: this.environment,
      vessel: this.vessel,
      anchor: this.anchor,
      aisTargets: this.aisTargets,
      alerts: this.alerts,
      tides: this.tides,
      forecast: this.forecast,
      bluetooth: this.bluetooth
    };
  },

  /**
   * Returns the value at the given '/'-separated path, or the whole state if no path is provided.
   * Example: getState('/navigation/position')
   */
  getState(path) {
    if (!path) return this.state;
    // Remove leading/trailing slashes and split
    const parts = path.replace(/^\/+|\/+$/g, '').split('/');
    let obj = this;
    for (const key of parts) {
      if (key === '*') continue; // support wildcard for some usages
      if (obj && typeof obj === 'object' && key in obj) {
        obj = obj[key];
      } else {
        return undefined;
      }
    }
    return obj;
  },
};
