/**
 * Shared State Data Model
 *
 * This module defines the base state data structure that can be used by both
 * client and server components. It provides a consistent data model across
 * the application and supports unit preferences.
 */
import { UNIT_PRESETS } from "./unitPreferences.js";

/**
 * Creates the base state data structure with default values
 * @param {Object} unitPreferences - Unit preferences to use (defaults to imperial)
 * @returns {Object} The state data structure
 */
export function createStateDataModel(unitPreferences = UNIT_PRESETS.IMPERIAL) {
  return {
    navigation: {
      position: {
        latitude: {
          value: null,
          units: "deg",
          label: "Lat",
          displayLabel: "Latitude",
          description: "Latitude",
        },
        longitude: {
          value: null,
          units: "deg",
          label: "Lon",
          displayLabel: "Longitude",
          description: "Longitude",
        },
        altitude: {
          value: null,
          units: unitPreferences.length,
          label: "Alt",
          displayLabel: "Altitude",
          description: "Altitude",
        },
        timestamp: null,
        source: null,
        status: {
          value: "initializing", // 'valid' | 'unavailable' | 'stale'
          lastUpdated: null,
        },
        gnss: {
          satellites: {
            value: null,
            units: "count",
            label: "Sats",
            displayLabel: "Satellites",
            description: "Satellites in View",
          },
          hdop: {
            value: null,
            units: "ratio",
            label: "HDOP",
            displayLabel: "HDOP",
            description: "Horizontal Dilution of Precision",
          },
          pdop: {
            value: null,
            units: "ratio",
            label: "PDOP",
            displayLabel: "PDOP",
            description: "Position Dilution of Precision",
          },
        },
      },
      course: {
        cog: {
          value: null,
          units: unitPreferences.angle,
          label: "COG",
          displayLabel: "Course Over Ground",
          description: "Course Over Ground",
        },
        heading: {
          magnetic: {
            value: null,
            units: unitPreferences.angle,
            label: "HDG (M)",
            displayLabel: "Magnetic Heading",
            description: "Magnetic Heading",
          },
          true: {
            value: null,
            units: unitPreferences.angle,
            label: "HDG",
            displayLabel: "Heading",
            description: "True Heading",
          },
        },
        variation: {
          value: null,
          units: unitPreferences.angle,
          label: "Var",
          displayLabel: "Variation",
          description: "Magnetic Variation",
        },
        rateOfTurn: {
          value: null,
          units: unitPreferences.angle + "/s",
          label: "ROT",
          displayLabel: "Rate of Turn",
          description: "Rate of Turn",
        },
      },
      speed: {
        sog: {
          value: null,
          units: unitPreferences.speed,
          label: "SOG",
          displayLabel: "Speed Over Ground",
          description: "Speed Over Ground",
        },
        stw: {
          value: null,
          units: unitPreferences.speed,
          label: "STW",
          displayLabel: "Speed Through Water",
          description: "Speed Through Water",
        },
      },
      trip: {
        log: {
          value: null,
          units: unitPreferences.length,
          label: "Log",
          displayLabel: "Trip Log",
          description: "Trip Log",
        },
        lastReset: null,
      },
      depth: {
        belowTransducer: {
          value: null,
          units: unitPreferences.length,
          label: "Depth",
          displayLabel: "Depth",
          description: "Depth Below Transducer",
        },
        belowKeel: {
          value: null,
          units: unitPreferences.length,
          label: "Depth (K)",
          displayLabel: "Depth Below Keel",
          description: "Depth Below Keel",
        },
        belowSurface: {
          value: null,
          units: unitPreferences.length,
          label: "Depth (S)",
          displayLabel: "Depth Below Surface",
          description: "Depth Below Surface",
        },
      },
      wind: {
        apparent: {
          speed: {
            value: null,
            units: unitPreferences.speed,
            label: "AWS",
            displayLabel: "Apparent Wind Speed",
            description: "Apparent Wind Speed",
          },
          angle: {
            value: null,
            units: unitPreferences.angle,
            side: null,
            label: "AWA",
            displayLabel: "Apparent Wind Angle",
            description: "Apparent Wind Angle",
          },
          direction: {
            value: null,
            units: unitPreferences.angle,
            reference: "true",
            label: "AWD",
            displayLabel: "Apparent Wind Direction",
            description: "Apparent Wind Direction",
          },
        },
        true: {
          speed: {
            value: null,
            units: unitPreferences.speed,
            label: "TWS",
            displayLabel: "True Wind Speed",
            description: "True Wind Speed",
          },
          direction: {
            value: null,
            units: unitPreferences.angle,
            reference: "true",
            label: "TWD",
            displayLabel: "True Wind Direction",
            description: "True Wind Direction",
          },
        },
      },
    },
    environment: {
      weather: {
        temperature: {
          air: {
            value: null,
            units: unitPreferences.temperature,
            label: "Air Temp",
            displayLabel: "Air Temperature",
            description: "Air Temperature",
          },
          water: {
            value: null,
            units: unitPreferences.temperature,
            label: "Water Temp",
            displayLabel: "Water Temperature",
            description: "Water Temperature",
          },
        },
        pressure: {
          value: null,
          units: unitPreferences.pressure,
          label: "Baro",
          displayLabel: "Barometric Pressure",
          description: "Barometric Pressure",
        },
        humidity: {
          value: null,
          units: "%",
          label: "Humidity",
          displayLabel: "Humidity",
          description: "Relative Humidity",
        },
      },
    },
    vessel: {
      info: {
        name: null,
        mmsi: null,
        callsign: null,
        type: null,
        dimensions: {
          length: {
            value: null,
            units: unitPreferences.length,
            label: "Length",
            displayLabel: "Length",
            description: "Vessel Length",
          },
          beam: {
            value: null,
            units: unitPreferences.length,
            label: "Beam",
            displayLabel: "Beam",
            description: "Vessel Beam",
          },
          draft: {
            value: null,
            units: unitPreferences.length,
            label: "Draft",
            displayLabel: "Draft",
            description: "Vessel Draft",
          },
        },
      },
      systems: {
        electrical: {
          battery1: {
            voltage: {
              value: null,
              units: "V",
              label: "Volts 1",
              displayLabel: "Battery 1 Voltage",
              description: "Battery 1 Voltage",
            },
            current: {
              value: null,
              units: "A",
              label: "Amps 1",
              displayLabel: "Battery 1 Current",
              description: "Battery 1 Current",
            },
            capacity: {
              value: null,
              units: "%",
              label: "Battery 1",
              displayLabel: "Battery 1 Capacity",
              description: "Battery 1 Capacity",
            },
          },
          battery2: {
            voltage: {
              value: null,
              units: "V",
              label: "Volts 2",
              displayLabel: "Battery 2 Voltage",
              description: "Battery 2 Voltage",
            },
            current: {
              value: null,
              units: "A",
              label: "Amps 2",
              displayLabel: "Battery 2 Current",
              description: "Battery 2 Current",
            },
            capacity: {
              value: null,
              units: "%",
              label: "Battery 2",
              displayLabel: "Battery 2 Capacity",
              description: "Battery 2 Capacity",
            },
          },
          battery3: {
            voltage: {
              value: null,
              units: "V",
              label: "Volts 3",
              displayLabel: "Battery 3 Voltage",
              description: "Battery 3 Voltage",
            },
            current: {
              value: null,
              units: "A",
              label: "Amps 3",
              displayLabel: "Battery 3 Current",
              description: "Battery 3 Current",
            },
            capacity: {
              value: null,
              units: "%",
              label: "Battery 3",
              displayLabel: "Battery 3 Capacity",
              description: "Battery 3 Capacity",
            },
          },
          battery4: {
            voltage: {
              value: null,
              units: "V",
              label: "Volts 4",
              displayLabel: "Battery 4 Voltage",
              description: "Battery 4 Voltage",
            },
            current: {
              value: null,
              units: "A",
              label: "Amps 4",
              displayLabel: "Battery 4 Current",
              description: "Battery 4 Current",
            },
            capacity: {
              value: null,
              units: "%",
              label: "Battery 4",
              displayLabel: "Battery 4 Capacity",
              description: "Battery 4 Capacity",
            },
          },
          sources: null,
        },
        propulsion: {
          engine1: {
            rpm: {
              value: null,
              units: "rpm",
              label: "RPM",
              displayLabel: "Engine 1 RPM",
              description: "Engine 1 RPM",
            },
            hours: {
              value: null,
              units: "hours",
              label: "Hours",
              displayLabel: "Engine 1 Hours",
              description: "Engine 1 Hours",
            },
            temperature: {
              value: null,
              units: unitPreferences.temperature,
              label: "Eng 1 Temp",
              displayLabel: "Engine 1 Temperature",
              description: "Engine 1 Temperature",
            },
            oilPressure: {
              value: null,
              units: unitPreferences.pressure,
              label: "Oil Press 1",
              displayLabel: "Oil Pressure 1",
              description: "Oil 1 Pressure",
            },
          },
          engine2: {
            rpm: {
              value: null,
              units: "rpm",
              label: "RPM 2",
              displayLabel: "Engine 2 RPM",
              description: "Engine 2 RPM",
            },
            hours: {
              value: null,
              units: "hours",
              label: "Hours 2",
              displayLabel: "Engine 2 Hours",
              description: "Engine 2 Hours",
            },
            temperature: {
              value: null,
              units: unitPreferences.temperature,
              label: "Eng 2 Temp",
              displayLabel: "Engine 2 Temperature",
              description: "Engine 2 Temperature",
            },
            oilPressure: {
              value: null,
              units: unitPreferences.pressure,
              label: "Oil Press 2",
              displayLabel: "Oil Pressure 2",
              description: "Oil Pressure 2",
            },
          },
          fuel1: {
            level: {
              value: null,
              units: unitPreferences.volume,
              label: "Fuel 1",
              displayLabel: "Fuel Level 1",
              description: "Fuel Level 1",
            },
            rate: {
              value: null,
              units: unitPreferences.volume + "/h",
              label: "Fuel Rate",
              displayLabel: "Fuel Consumption",
              description: "Fuel Consumption Rate",
            },
            economy: {
              value: null,
              units: unitPreferences.length + "/" + unitPreferences.volume,
              label: "Fuel Econ",
              displayLabel: "Fuel Economy",
              description: "Fuel Economy",
            },
          },
          fuel2: {
            level: {
              value: null,
              units: unitPreferences.volume,
              label: "Fuel 2",
              displayLabel: "Fuel Level 2",
              description: "Fuel Level 2",
            },
            rate: {
              value: null,
              units: unitPreferences.volume + "/h",
              label: "Fuel Rate",
              displayLabel: "Fuel Consumption",
              description: "Fuel Consumption Rate",
            },
            economy: {
              value: null,
              units: unitPreferences.length + "/" + unitPreferences.volume,
              label: "Fuel Econ",
              displayLabel: "Fuel Economy",
              description: "Fuel Economy",
            },
          },
        },
        tanks: {
          freshWater1: {
            value: null,
            units: unitPreferences.volume,
            label: "Water 1",
            displayLabel: "Fresh Water 1",
            description: "Fresh Water 1 Level",
          },
          freshWater2: {
            value: null,
            units: unitPreferences.volume,
            label: "Water 2",
            displayLabel: "Fresh Water 2",
            description: "Fresh Water 2 Level",
          },
          wasteWater1: {
            value: null,
            units: unitPreferences.volume,
            label: "Waste 1",
            displayLabel: "Waste Water 1",
            description: "Waste Water 1 Level",
          },
          wasteWater2: {
            value: null,
            units: unitPreferences.volume,
            label: "Waste 2",
            displayLabel: "Waste Water 2",
            description: "Waste Water 2 Level",
          },
          blackWater1: {
            value: null,
            units: unitPreferences.volume,
            label: "Black 1",
            displayLabel: "Black Water 1",
            description: "Black Water 1 Level",
          },
          blackWater2: {
            value: null,
            units: unitPreferences.volume,
            label: "Black 2",
            displayLabel: "Black Water 2",
            description: "Black Water 2 Level",
          },
        },
      },
    },
    aisTargets: {},
    anchor: {
      anchorDropLocation: {
        position: {
          latitude: {
            value: null,
            units: "deg",
            label: "Drop Lat",
            description: "Anchor Drop Latitude",
          },
          longitude: {
            value: null,
            units: "deg",
            label: "Drop Lon",
            description: "Anchor Drop Longitude",
          },
        },
        time: null,
        depth: {
          value: null,
          units: unitPreferences.length,
          label: "Drop Depth",
          description: "Depth at Anchor Drop",
        },
        distancesFromCurrent: {
          value: 0,
          units: unitPreferences.length,
          label: "Dist",
          description: "Distance from Current Position",
        },
        distancesFromDrop: {
          value: 0,
          units: unitPreferences.length,
          label: "Swing",
          description: "Swing Distance from Drop",
        },
        originalBearing: {
          value: 0,
          units: unitPreferences.angle,
          label: "Orig Brg",
          description: "Original Bearing",
        },
        bearing: {
          value: 0,
          units: unitPreferences.angle,
          label: "Bearing",
          description: "Current Bearing",
        },
      },
      anchorLocation: {
        position: {
          latitude: {
            value: null,
            units: "deg",
            label: "Anc Lat",
            description: "Anchor Latitude",
          },
          longitude: {
            value: null,
            units: "deg",
            label: "Anc Lon",
            description: "Anchor Longitude",
          },
        },
        time: null,
        depth: {
          value: null,
          units: unitPreferences.length,
          label: "Anc Depth",
          description: "Depth at Anchor Location",
        },
        distancesFromCurrent: {
          value: 0,
          units: unitPreferences.length,
          label: "Anc Dist",
          description: "Distance from Anchor to Vessel",
        },
        distancesFromDrop: {
          value: 0,
          units: unitPreferences.length,
          label: "Drag Dist",
          description: "Distance Anchor has Dragged",
        },
        originalBearing: {
          value: 0,
          units: unitPreferences.angle,
          label: "Orig Brg",
          description: "Original Bearing to Anchor",
        },
        bearing: {
          value: 0,
          units: unitPreferences.angle,
          label: "Anc Brg",
          description: "Current Bearing to Anchor",
        },
      },
      rode: {
        amount: 0,
        units: unitPreferences.length,
        label: "Rode",
        description: "Anchor Rode Length",
      },
      criticalRange: {
        r: 0,
        units: unitPreferences.length,
        label: "Crit Range",
        description: "Critical Anchor Range",
      },
      warningRange: {
        r: 15,
        units: unitPreferences.length,
        label: "Warn Range",
        description: "Warning Anchor Range",
      },
      defaultScope: {
        value: 5,
        units: "ratio",
        label: "Scope",
        description: "Anchor Scope Ratio",
      },
      dragging: false,
      aisWarning: false,
      anchorDeployed: false,
      history: [],
      useDeviceGPS: true,
    },
    alerts: {
      active: [], // Currently active alerts/notifications
      history: [], // Past/resolved alerts (optional)
      definitions: [], // User/system-defined alert rules (optional)
      processingQueue: [], // Alert ids currently being processed (optional)
      muted: [], // Alert ids currently muted (optional)
      deviceSubscriptions: {}, // deviceId => [alert types/categories] (optional)
    },
  };
}
