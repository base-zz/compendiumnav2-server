import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { 
  findUserByUsername, 
  findUserByEmail, 
  createUser, 
  findBoatById, 
  createBoat, 
  associateUserWithBoat, 
  getBoatsForUser,
  registerBoatKey
} from './database.js';
import { 
  hashPassword, 
  generateToken, 
  verifyToken, 
  generateResetToken 
} from './auth.js';

const router = express.Router();

// Middleware
router.use(bodyParser.json());
router.use(cors());

// USER REGISTRATION
router.post("/api/register", async (req, res) => {
  try {
    const { username, password, email } = req.body;
    if (!username || !password)
      return res
        .status(400)
        .json({ success: false, error: "Username and password required" });
    
    const existingUser = await findUserByUsername(username);
    if (existingUser)
      return res
        .status(400)
        .json({ success: false, error: "Username already exists" });
    
    await createUser({
      username,
      passwordHash: hashPassword(password),
      email,
    });
    
    res.json({ success: true, message: "User registered!" });
  } catch (e) {
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// USER LOGIN
router.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  
  const user = await findUserByUsername(username);
  if (!user || user.passwordHash !== hashPassword(password)) {
    return res
      .status(401)
      .json({ success: false, error: "Invalid credentials" });
  }
  
  const userBoats = await getBoatsForUser(username);
  const token = generateToken({ username, boats: userBoats });
  
  res.json({ success: true, token, boats: userBoats });
});

// BOAT REGISTRATION
router.post("/api/boat/register", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const decoded = verifyToken(token);
  if (!decoded)
    return res.status(401).json({ success: false, error: "Invalid token" });
  
  const { boatName, boatType, loa, beam, draft, airDraft, mmsi } = req.body;
  if (!boatName)
    return res
      .status(400)
      .json({ success: false, error: "boatName is required" });

  const boatId = crypto.randomUUID();
  
  await createBoat({
    boatId,
    boatName,
    boatType,
    loa,
    beam,
    draft,
    airDraft,
    mmsi,
    registeredBy: decoded.username,
    createdAt: new Date().toISOString(),
  });
  
  await associateUserWithBoat(decoded.username, boatId);
  
  res.json({ success: true, boatId });
});

// BOAT PUBLIC KEY REGISTRATION
router.post("/api/boat/register-key", async (req, res) => {
  const { boatId, publicKey } = req.body;

  if (!boatId || !publicKey) {
    return res.status(400).json({
      success: false,
      error: "boatId and publicKey are required",
    });
  }

  // Check if boat exists - if not, create it as an unregistered boat
  let boat = await findBoatById(boatId);
  if (!boat) {
    boat = {
      boatId,
      boatName: `Unregistered Boat ${boatId.substring(0, 8)}`,
      createdAt: new Date().toISOString(),
      isUnregistered: true,
    };
    await createBoat(boat);
  }

  // Register the key
  await registerBoatKey(boatId, publicKey);
  
  res.json({
    success: true,
    message: "Public key registered successfully",
    boatId,
  });
});

// ASSOCIATE USER TO BOAT
router.post("/api/boat/join", async (req, res) => {
  const { boatId } = req.body;
  const token = req.headers.authorization?.split(" ")[1];
  const decoded = verifyToken(token);
  if (!decoded)
    return res.status(401).json({ success: false, error: "Invalid token" });
  
  const boat = await findBoatById(boatId);
  if (!boat)
    return res.status(404).json({ success: false, error: "Boat not found" });
  
  await associateUserWithBoat(decoded.username, boatId);
  
  res.json({
    success: true,
    message: `User ${decoded.username} joined boat ${boatId}`,
  });
});

// LIST USER'S BOATS
router.get("/api/boats", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const decoded = verifyToken(token);
  if (!decoded)
    return res.status(401).json({ success: false, error: "Invalid token" });
  
  const userBoats = await getBoatsForUser(decoded.username);
  
  res.json({ success: true, boats: userBoats });
});

// PASSWORD RESET REQUEST
router.post("/api/password-reset", async (req, res) => {
  const { email } = req.body;
  
  const user = await findUserByEmail(email);
  if (user) {
    const resetToken = generateResetToken(user.username);
    
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    
    const resetUrl = `${
      process.env.FRONTEND_URL || "http://localhost:5173"
    }/reset-password?token=${resetToken}`;
    
    await transporter.sendMail({
      to: email,
      from: process.env.SMTP_FROM || "no-reply@compendiumnav.com",
      subject: "Password Reset",
      text: `To reset your password, click the following link: ${resetUrl}`,
    });
  }
  
  res.json({
    message: "If your email is registered, a reset link has been sent.",
  });
});

// PASSWORD RESET SUBMISSION
router.post("/api/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  try {
    const payload = verifyToken(token);
    
    const user = await findUserByUsername(payload.username);
    if (!user) return res.status(400).json({ error: "Invalid token." });
    
    user.passwordHash = hashPassword(newPassword);
    // Update user in database
    
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: "Invalid or expired token." });
  }
});

// HEALTH CHECK
router.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    version: process.env.npm_package_version,
    uptime: process.uptime(),
  });
});

export default router;
