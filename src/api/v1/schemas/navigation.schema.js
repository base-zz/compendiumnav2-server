// src/server/api/v1/schemas/navigation.schema.js
import Joi from 'joi';

// Common schemas
const coordinateSchema = Joi.number().min(-180).max(180).precision(8);
const timestampSchema = Joi.date().iso();
const unitsSchema = Joi.string().valid('knots', 'm/s', 'km/h').default('knots');

// Position schemas
export const positionQuerySchema = Joi.object({
  maxAge: Joi.number().integer().min(0).description('Maximum acceptable age of data in milliseconds'),
  format: Joi.string().valid('decimal', 'dms').default('decimal')
});

export const positionResponseSchema = Joi.object({
  latitude: coordinateSchema.required(),
  longitude: coordinateSchema.required(),
  timestamp: timestampSchema.required(),
  accuracy: Joi.number().min(0).optional(),
  status: Joi.string().valid('valid', 'invalid', 'stale').required()
});

// Heading schemas
export const headingQuerySchema = Joi.object({
  type: Joi.string().valid('true', 'magnetic', 'both').default('both'),
  units: Joi.string().valid('degrees', 'radians').default('degrees')
});

export const headingResponseSchema = Joi.object({
  true: Joi.number().min(0).max(360).allow(null),
  magnetic: Joi.number().min(0).max(360).allow(null),
  deviation: Joi.number().min(-180).max(180).allow(null),
  timestamp: timestampSchema.required()
});

// Speed schemas
export const speedQuerySchema = Joi.object({
  units: unitsSchema
});

export const speedResponseSchema = Joi.object({
  overGround: Joi.number().min(0).allow(null),
  throughWater: Joi.number().min(0).allow(null),
  units: unitsSchema.required(),
  timestamp: timestampSchema.required()
});

// Battery schemas
export const batteryQuerySchema = Joi.object({
  battery: Joi.string().valid('house', 'start', 'all').default('all')
});

export const batteryResponseSchema = Joi.object({
  house: Joi.object({
    charge: Joi.number().min(0).max(100).allow(null),
    voltage: Joi.number().min(0).allow(null),
    amperage: Joi.number().allow(null),
    status: Joi.string().valid('charging', 'discharging', 'full', 'critical', 'unknown').required()
  }).required(),
  start: Joi.object({
    charge: Joi.number().min(0).max(100).allow(null),
    voltage: Joi.number().min(0).allow(null),
    amperage: Joi.number().allow(null),
    status: Joi.string().valid('charging', 'discharging', 'full', 'critical', 'unknown').required()
  }).required()
});

// Tank schemas
export const tankQuerySchema = Joi.object({
  tank: Joi.string().valid('fuel', 'water', 'waste', 'all').default('all'),
  units: Joi.string().valid('liters', 'gallons', 'percentage').default('liters')
});

export const tankResponseSchema = Joi.object({
  fuel: Joi.object({
    level: Joi.number().min(0).max(100).allow(null),
    capacity: Joi.number().min(0).allow(null),
    remaining: Joi.number().min(0).allow(null),
    units: Joi.string().required()
  }).required(),
  water: Joi.object({
    level: Joi.number().min(0).max(100).allow(null),
    capacity: Joi.number().min(0).allow(null),
    remaining: Joi.number().min(0).allow(null),
    units: Joi.string().required()
  }).required(),
  waste: Joi.object({
    level: Joi.number().min(0).max(100).allow(null),
    capacity: Joi.number().min(0).allow(null),
    remaining: Joi.number().min(0).allow(null),
    units: Joi.string().required()
  }).required()
});

// Environment schemas
export const windQuerySchema = Joi.object({
  type: Joi.string().valid('true', 'apparent', 'both').default('both'),
  units: unitsSchema
});

export const depthQuerySchema = Joi.object({
  units: Joi.string().valid('meters', 'feet', 'fathoms').default('meters')
});

// Snapshot schema
export const snapshotQuerySchema = Joi.object({
  include: Joi.string().valid('all', 'position', 'instruments', 'systems').default('all'),
  maxAge: Joi.number().integer().min(0).default(5000)
});

export const snapshotResponseSchema = Joi.object({
  position: positionResponseSchema.required(),
  instruments: Joi.object({
    heading: headingResponseSchema.required(),
    speed: speedResponseSchema.required(),
    depth: Joi.number().min(0).allow(null),
    wind: Joi.object({
      true: Joi.object({
        speed: Joi.number().min(0).allow(null),
        angle: Joi.number().min(0).max(360).allow(null)
      }).required(),
      apparent: Joi.object({
        speed: Joi.number().min(0).allow(null),
        angle: Joi.number().min(0).max(360).allow(null)
      }).required()
    }).required()
  }).required(),
  systems: Joi.object({
    batteries: batteryResponseSchema.required(),
    tanks: tankResponseSchema.required()
  }).required(),
  meta: Joi.object({
    lastUpdated: timestampSchema.required(),
    signalKState: Joi.object({
      websocket: Joi.boolean().required(),
      polling: Joi.boolean().required()
    }).required()
  }).required()
});

// Status schema
export const statusResponseSchema = Joi.object({
  positionAvailable: Joi.boolean().required(),
  instrumentsAvailable: Joi.boolean().required(),
  systemsAvailable: Joi.boolean().required(),
  signalKConnection: Joi.boolean().required(),
  lastUpdate: timestampSchema.required()
});