/**
 * Widget Data Configuration
 *
 * This file defines the configuration for all widget data sources in the application.
 * It provides a centralized place to define new data sources without modifying widget components.
 */

/**
 * Widget data source configuration
 * Each entry defines:
 * - id: Unique identifier for the data source
 * - type: Widget type that can display this data (instrument, tank, battery, sail360)
 * - category: Grouping category for the UI
 * - statePath: Array of keys to navigate to the data in the state store
 * - label: Short label for display in compact UIs
 * - displayLabel: User-friendly label for display in larger UIs
 * - description: Detailed description of the data
 * - defaultUnits: Default units to use if not specified in the data
 * - aspectRatio: Aspect ratio for the widget (1 for square, 16/9 for widescreen, etc.)
 * - maintainAspectRatio: Whether to enforce the aspect ratio
 */
export const WIDGET_DATA_SOURCES = [
  // Speed data
  {
    id: "speedOverGround",
    type: "instrument",
    category: "Speed",
    statePath: ["navigation", "speed", "sog"],
    label: "SOG",
    displayLabel: "Speed Over Ground",
    description: "Vessel speed over ground",
    defaultUnits: "kts",
    aspectRatio: 1, // Square aspect ratio
    maintainAspectRatio: true,
  },
  {
    id: "speedThroughWater",
    type: "instrument",
    category: "Speed",
    statePath: ["navigation", "speed", "stw"],
    label: "STW",
    displayLabel: "Speed Through Water",
    description: "Vessel speed through water",
    defaultUnits: "kts",
    aspectRatio: 1, // Square aspect ratio
    maintainAspectRatio: true,
  },
  {
    id: "speedThroughWater",
    type: "instrument",
    category: "Speed",
    statePath: ["navigation", "speed", "stw"],
    label: "STW",
    displayLabel: "Speed Through Water",
    description: "Vessel speed through water",
    defaultUnits: "kts",
  },

  // Depth data
  {
    id: "depth",
    type: "instrument",
    category: "Depth",
    statePath: ["navigation", "depth", "belowTransducer"],
    label: "Depth",
    displayLabel: "Depth",
    description: "Depth below transducer",
    defaultUnits: "ft",
  },

  // Wind data
  {
    id: "windSpeedTrue",
    type: "instrument",
    category: "Wind",
    statePath: ["navigation", "wind", "true", "speed"],
    label: "TWS",
    displayLabel: "True Wind Speed",
    description: "True wind speed",
    defaultUnits: "kts",
  },
  {
    id: "windAngleTrue",
    type: "instrument",
    category: "Wind",
    statePath: ["navigation", "wind", "true", "direction"],
    label: "TWD",
    displayLabel: "True Wind Direction",
    description: "True wind direction",
    defaultUnits: "°",
  },
  {
    id: "windSpeedApparent",
    type: "instrument",
    category: "Wind",
    statePath: ["navigation", "wind", "apparent", "speed"],
    label: "AWS",
    displayLabel: "Apparent Wind Speed",
    description: "Apparent wind speed",
    defaultUnits: "kts",
  },
  {
    id: "windAngleApparent",
    type: "instrument",
    category: "Wind",
    statePath: ["navigation", "wind", "apparent", "angle"],
    label: "AWA",
    displayLabel: "Apparent Wind Angle",
    description: "Apparent wind angle, negative to port",
    defaultUnits: "°",
  },

  // Course data
  {
    id: "heading",
    type: "instrument",
    category: "Course",
    statePath: ["navigation", "course", "heading", "true"],
    label: "HDG",
    displayLabel: "Heading",
    description: "Current true heading of the vessel",
    defaultUnits: "°",
  },
  {
    id: "courseOverGround",
    type: "instrument",
    category: "Course",
    statePath: ["navigation", "course", "cog"],
    label: "COG",
    displayLabel: "Course Over Ground",
    description: "Course over ground (true)",
    defaultUnits: "°",
  },

  // Environment data
  {
    id: "waterTemp",
    type: "instrument",
    category: "Environment",
    statePath: ["environment", "weather", "temperature", "water"],
    label: "Water Temp",
    displayLabel: "Water Temperature",
    description: "Current water temperature",
    defaultUnits: "°C",
  },
  {
    id: "airTemp",
    type: "instrument",
    category: "Environment",
    statePath: ["environment", "weather", "temperature", "air"],
    label: "Air Temp",
    displayLabel: "Air Temperature",
    description: "Current outside air temperature",
    defaultUnits: "°C",
  },
  {
    id: "pressure",
    type: "instrument",
    category: "Environment",
    statePath: ["environment", "weather", "pressure"],
    label: "Baro",
    displayLabel: "Barometric Pressure",
    description: "Current outside air ambient pressure",
    defaultUnits: "hPa",
  },

  // Tank data - Fresh Water Tanks
  {
    id: "freshWater1",
    type: "tank",
    category: "Tanks",
    statePath: ["vessel", "systems", "tanks", "freshWater1"],
    label: "Water 1",
    displayLabel: "Fresh Water 1",
    description: "Fresh water tank 1 level",
    defaultUnits: "%",
    threshold: 20,
    thresholdOperator: "LESS_THAN", // Alert when level is LESS THAN threshold
    fluidType: "water", // Use blue color for fresh water
  },
  {
    id: "freshWater2",
    type: "tank",
    category: "Tanks",
    statePath: ["vessel", "systems", "tanks", "freshWater2"],
    label: "Water 2",
    displayLabel: "Fresh Water 2",
    description: "Fresh water tank 2 level",
    defaultUnits: "%",
    threshold: 20,
    thresholdOperator: "LESS_THAN", // Alert when level is LESS THAN threshold
    fluidType: "water", // Use blue color for fresh water
  },

  // Waste Water Tanks
  {
    id: "wasteWater1",
    type: "tank",
    category: "Tanks",
    statePath: ["vessel", "systems", "tanks", "wasteWater1"],
    label: "Waste 1",
    displayLabel: "Waste Water 1",
    description: "Waste water tank 1 level",
    defaultUnits: "%",
    threshold: 80,
    thresholdOperator: "GREATER_THAN", // Alert when level is GREATER THAN threshold
    fluidType: "waste", // Use brown color for waste water
  },
  {
    id: "wasteWater2",
    type: "tank",
    category: "Tanks",
    statePath: ["vessel", "systems", "tanks", "wasteWater2"],
    label: "Waste 2",
    displayLabel: "Waste Water 2",
    description: "Waste water tank 2 level",
    defaultUnits: "%",
    threshold: 80,
    thresholdOperator: "GREATER_THAN", // Alert when level is GREATER THAN threshold
    fluidType: "waste", // Use brown color for waste water
  },

  // Black Water Tanks
  {
    id: "blackWater1",
    type: "tank",
    category: "Tanks",
    statePath: ["vessel", "systems", "tanks", "blackWater1"],
    label: "Black 1",
    displayLabel: "Black Water 1",
    description: "Black water tank 1 level",
    defaultUnits: "%",
    threshold: 80,
    thresholdOperator: "GREATER_THAN", // Alert when level is GREATER THAN threshold
    fluidType: "black", // Use dark color for black water
  },
  {
    id: "blackWater2",
    type: "tank",
    category: "Tanks",
    statePath: ["vessel", "systems", "tanks", "blackWater2"],
    label: "Black 2",
    displayLabel: "Black Water 2",
    description: "Black water tank 2 level",
    defaultUnits: "%",
    threshold: 80,
    thresholdOperator: "GREATER_THAN", // Alert when level is GREATER THAN threshold
    fluidType: "black", // Use dark color for black water
  },

  // Fuel Tanks
  {
    id: "fuel1",
    type: "tank",
    category: "Tanks",
    statePath: ["vessel", "systems", "propulsion", "fuel1", "level"],
    label: "Fuel 1",
    displayLabel: "Fuel Tank 1",
    description: "Fuel tank 1 level",
    defaultUnits: "%",
    threshold: 20,
    thresholdOperator: "LESS_THAN", // Alert when level is LESS THAN threshold
    fluidType: "fuel", // Use amber/orange color for fuel
  },
  {
    id: "fuel2",
    type: "tank",
    category: "Tanks",
    statePath: ["vessel", "systems", "propulsion", "fuel2", "level"],
    label: "Fuel 2",
    displayLabel: "Fuel Tank 2",
    description: "Fuel tank 2 level",
    defaultUnits: "%",
    threshold: 20,
    thresholdOperator: "LESS_THAN", // Alert when level is LESS THAN threshold
    fluidType: "fuel", // Use amber/orange color for fuel
  },

  // Battery data
  {
    id: "battery1",
    type: "battery",
    category: "Electrical",
    statePath: ["vessel", "systems", "electrical", "battery1"],
    valueProperty: "capacity.value",
    unitsProperty: "capacity.units",
    label: "Battery 1",
    displayLabel: "Battery 1",
    description: "Battery 1",
    defaultUnits: "%",
    threshold: 20,
    thresholdOperator: "LESS_THAN", // Alert when level is LESS THAN threshold
    relatedData: {
      voltage: {
        label: "Voltage",
        property: "voltage.value",
        units: "voltage.units",
      },
      amperage: {
        label: "Current",
        property: "current.value",
        units: "current.units",
      },
    },
  },
  {
    id: "battery2",
    type: "battery",
    category: "Electrical",
    statePath: ["vessel", "systems", "electrical", "battery2"],
    valueProperty: "capacity.value",
    unitsProperty: "capacity.units",
    label: "Battery 2",
    displayLabel: "Battery 2",
    description: "Battery 2",
    defaultUnits: "%",
    threshold: 20,
    thresholdOperator: "LESS_THAN", // Alert when level is LESS THAN threshold
    relatedData: {
      voltage: {
        label: "Voltage",
        property: "voltage.value",
        units: "voltage.units",
      },
      amperage: {
        label: "Current",
        property: "current.value",
        units: "current.units",
      },
    },
  },
  {
    id: "battery3",
    type: "battery",
    category: "Electrical",
    statePath: ["vessel", "systems", "electrical", "battery3"],
    valueProperty: "capacity.value",
    unitsProperty: "capacity.units",
    label: "Battery 3",
    displayLabel: "Battery 3",
    description: "Battery 3",
    defaultUnits: "%",
    threshold: 20,
    thresholdOperator: "LESS_THAN", // Alert when level is LESS THAN threshold
    relatedData: {
      voltage: {
        label: "Voltage",
        property: "voltage.value",
        units: "voltage.units",
      },
      amperage: {
        label: "Current",
        property: "current.value",
        units: "current.units",
      },
    },
  },
  {
    id: "battery4",
    type: "battery",
    category: "Electrical",
    statePath: ["vessel", "systems", "electrical", "battery4"],
    valueProperty: "capacity.value",
    unitsProperty: "capacity.units",
    label: "Battery 4",
    displayLabel: "Battery 4",
    description: "Battery 4",
    defaultUnits: "%",
    threshold: 20,
    thresholdOperator: "LESS_THAN", // Alert when level is LESS THAN threshold
    relatedData: {
      voltage: {
        label: "Voltage",
        property: "voltage.value",
        units: "voltage.units",
      },
      amperage: {
        label: "Current",
        property: "current.value",
        units: "current.units",
      },
    },
  },
];

/**
 * Get a data source configuration by ID
 * @param {string} id - The data source ID
 * @returns {Object|null} The data source configuration or null if not found
 */
export function getDataSourceById(id) {
  return WIDGET_DATA_SOURCES.find((source) => source.id === id) || null;
}

/**
 * Get all data sources for a specific widget type
 * @param {string} type - The widget type
 * @returns {Array} Array of data sources for the specified type
 */
export function getDataSourcesByType(type) {
  return WIDGET_DATA_SOURCES.filter((source) => source.type === type);
}

/**
 * Get all data sources grouped by category
 * @returns {Object} Object with categories as keys and arrays of data sources as values
 */
export function getDataSourcesByCategory() {
  return WIDGET_DATA_SOURCES.reduce((acc, source) => {
    if (!acc[source.category]) {
      acc[source.category] = [];
    }
    acc[source.category].push(source);
    return acc;
  }, {});
}

/**
 * Get data from the state using a data source configuration
 * @param {Object} state - The state object
 * @param {string|Object} dataSourceId - The data source ID or configuration object
 * @returns {Object} The data object with value, units, label, etc.
 */
export function getDataFromState(state, dataSourceId) {
  if (!state) {
    return null;
  }

  // Get the data source configuration if an ID was provided
  const dataSource =
    typeof dataSourceId === "string"
      ? getDataSourceById(dataSourceId)
      : dataSourceId;

  if (!dataSource) {
    return null;
  }

  // Use the statePath array for direct access (more efficient)
  let data = state;

  // Log each step of the path traversal
  for (let i = 0; i < dataSource.statePath.length; i++) {
    const part = dataSource.statePath[i];

    // Check if the property exists before accessing it
    if (!(part in data)) {
      if (dataSource.type === "battery") {
        console.log(`  - ERROR: '${part}' not found in data at step ${i}`);
      }
      return null;
    }

    data = data[part];
  }

  if (!data) {
    return null;
  }

  // Handle data sources with valueProperty and unitsProperty (for nested structures)
  let value, units;

  if (dataSource.valueProperty) {
    // Handle nested properties like 'capacity.value'
    const props = dataSource.valueProperty.split(".");
    let nestedValue = data;
    for (const prop of props) {
      if (nestedValue && typeof nestedValue === "object") {
        nestedValue = nestedValue[prop];
      } else {
        nestedValue = undefined;
        break;
      }
    }
    value = nestedValue;
  } else {
    // Default behavior
    value = data.value;
  }

  if (dataSource.unitsProperty) {
    // Handle nested properties like 'capacity.units'
    const props = dataSource.unitsProperty.split(".");
    let nestedUnits = data;
    for (const prop of props) {
      if (nestedUnits && typeof nestedUnits === "object") {
        nestedUnits = nestedUnits[prop];
      } else {
        nestedUnits = undefined;
        break;
      }
    }
    units = nestedUnits || dataSource.defaultUnits;
  } else {
    // Default behavior
    units = data.units || dataSource.defaultUnits;
  }

  const r = {
    value: value,
    units: units,
    label: data.label || dataSource.label,
    displayLabel: data.displayLabel || dataSource.displayLabel,
    description: data.description || dataSource.description,
  };

  // For battery widgets, add voltage and current data
  if (dataSource.type === "battery" && data) {
    if (data.voltage && data.voltage.value !== undefined) {
      r.voltage = data.voltage.value;
      r.voltageUnits = data.voltage.units || "V";
    }

    if (data.current && data.current.value !== undefined) {
      r.amperage = data.current.value;
      r.amperageUnits = data.current.units || "A";
    }
  }

  // Handle related data for battery widgets
  if (dataSource.type === "battery" && dataSource.relatedData) {
    // Process voltage data if available
    if (dataSource.relatedData.voltage) {
      // Get the property path for voltage
      const voltageProps = dataSource.relatedData.voltage.property.split(".");
      let voltageValue = data;

      // Navigate through the property path
      for (const prop of voltageProps) {
        if (voltageValue && typeof voltageValue === "object") {
          voltageValue = voltageValue[prop];
        } else {
          voltageValue = undefined;
          break;
        }
      }

      // Get the units path for voltage
      const voltageUnitsProps = dataSource.relatedData.voltage.units.split(".");
      let voltageUnits = data;

      // Navigate through the units path
      for (const prop of voltageUnitsProps) {
        if (voltageUnits && typeof voltageUnits === "object") {
          voltageUnits = voltageUnits[prop];
        } else {
          voltageUnits = undefined;
          break;
        }
      }

      if (voltageValue !== undefined) {
        r.voltage = voltageValue;
        r.voltageUnits = voltageUnits || "V";
      }
    }

    // Process current/amperage data if available
    if (dataSource.relatedData.amperage) {
      // Get the property path for amperage
      const amperageProps = dataSource.relatedData.amperage.property.split(".");
      let amperageValue = data;

      // Navigate through the property path
      for (const prop of amperageProps) {
        if (amperageValue && typeof amperageValue === "object") {
          amperageValue = amperageValue[prop];
        } else {
          amperageValue = undefined;
          break;
        }
      }

      // Get the units path for amperage
      const amperageUnitsProps =
        dataSource.relatedData.amperage.units.split(".");
      let amperageUnits = data;

      // Navigate through the units path
      for (const prop of amperageUnitsProps) {
        if (amperageUnits && typeof amperageUnits === "object") {
          amperageUnits = amperageUnits[prop];
        } else {
          amperageUnits = undefined;
          break;
        }
      }

      if (amperageValue !== undefined) {
        r.amperage = amperageValue;
        r.amperageUnits = amperageUnits || "A";
      }
    }
  }

  return r;
}
