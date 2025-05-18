// src/server/middleware/validation.js
import { BadRequestError } from '../errors.js';

export const validate = (schema) => (req, res, next) => {
  const { error } = schema.validate(req.body);
  if (error) {
    throw new BadRequestError(error.details[0].message);
  }
  next();
};