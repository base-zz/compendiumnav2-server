import Joi from 'joi';

export const anchorPositionSchema = Joi.object({
  lat: Joi.number().min(-90).max(90).required(),
  lon: Joi.number().min(-180).max(180).required(),
  depth: Joi.number().positive().optional()
});

export const rodeSchema = Joi.object({
  length: Joi.number().positive().required(),
  units: Joi.string().valid('feet', 'meters').default('feet')
});

export const historyQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(10),
  since: Joi.date().iso().optional()
});