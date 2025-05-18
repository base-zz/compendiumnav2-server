// src/server/api/index.js
import express from 'express';
import v1Router from './v1/index.js';

const router = express.Router();
router.use('/v1', v1Router); // Mounts all v1 routes

export default router;