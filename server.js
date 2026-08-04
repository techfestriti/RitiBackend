require('dotenv').config();
const express = require('express');
const compression = require('compression');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dns = require('dns').promises;

const app = express();

const EVENT_CONFIG = {
  'PROMPT ARENA - Prompt Engineering': { type: 'individual' },
  'VISION CRAFT - Prompt to Website': { type: 'group', minTeammates: 1, maxTeammates: 1 },
  'CYPHRA - Debugging': { type: 'individual' },
  'VESTIGE ALIBI - Crime Investigation': { type: 'group', minTeammates: 1, maxTeammates: 1 },
  'SYNTH & STEEL - Idea Presentation': { type: 'group', minTeammates: 0, maxTeammates: 2 },
  'THE OBSIDIAN TRAIL - Treasure Hunt': { type: 'group', minTeammates: 2, maxTeammates: 2 },
  'MEMORA - Meme Creation': { type: 'individual' }
};

const mxCache = new Map();
const MX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function hasValidMxRecord(email) {
  const domain = email?.split('@')[1];
  if (!domain) return false;

  const cached = mxCache.get(domain);
  if (cached && cached.expiry > Date.now()) {
    return cached.result;
  }

  let result;
  try {
    const records = await Promise.race([
      dns.resolveMx(domain),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), 3000))
    ]);
    result = records.some(r => r.exchange && r.exchange !== '.');
  } catch (err) {
    if (err.message === 'DNS timeout') {
      console.warn(`MX lookup timed out for domain "${domain}" — allowing registration through`);
      result = true;
    } else {
      result = false;
    }
  }

  mxCache.set(domain, { result, expiry: Date.now() + MX_CACHE_TTL_MS });
  return result;
}

if (!process.env.MONGODB_URI) {
  console.error('❌ FATAL ERROR: MONGODB_URI not configured in environment variables');
  process.exit(1);
}

if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
  console.error('❌ FATAL ERROR: ADMIN_USERNAME / ADMIN_PASSWORD not configured in environment variables');
  process.exit(1);
}

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const extraOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const staticAllowedOrigins = [
  'https://golden-frangollo-580ffa.netlify.app',
  'http://localhost:5173',
  'http://localhost:3000',
  ...extraOrigins
];

const netlifyPreviewPattern = /^https:\/\/[a-z0-9-]+--golden-frangollo-580ffa\.netlify\.app$/;

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    if (staticAllowedOrigins.includes(origin) || netlifyPreviewPattern.test(origin)) {
      return callback(null, true);
    }

    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'admin-auth'],
  credentials: true
}));

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/uploads', express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${Date.now()}${ext}`);
  }
});

const upload = multer({ 
  storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg'];
    allowedTypes.includes(file.mimetype) 
      ? cb(null, true) 
      : cb(new Error('Only JPEG/PNG images allowed'));
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 20000,
      maxPoolSize: 50,
      retryWrites: true,
      w: 'majority'
    });
    console.log('✅ MongoDB Connected!');
  } catch (err) {
    console.error('❌ MongoDB Connection Error:', err.message);
    process.exit(1);
  }
};

const registrationSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { 
    type: String, 
    required: true,
    trim: true,
    lowercase: true,
    validate: {
      validator: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
      message: props => `${props.value} is not a valid email!`
    }
  },
  contact: { 
    type: String,
    required: true,
    validate: {
      validator: v => /^[6-9]\d{9}$/.test(v),
      message: props => `${props.value} is not a valid Indian number!`
    }
  },
  college: { type: String, required: true },
  course: { type: String, required: true },
  sem: { type: String, required: true },
  selectedEvents: { 
    type: [String], 
    required: true,
    validate: {
      validator: v => v.length > 0,
      message: 'Select at least one event!'
    }
  },
  idPhotoPath: String,
  groupTeams: [{
    eventName: { type: String, required: true },
    members: [{
      name: { type: String, required: true, trim: true },
      email: {
        type: String,
        required: true,
        trim: true,
        validate: {
          validator: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
          message: props => `${props.value} is not a valid email!`
        }
      },
      contact: {
        type: String,
        required: true,
        validate: {
          validator: v => /^[6-9]\d{9}$/.test(v),
          message: props => `${props.value} is not a valid Indian number!`
        }
      },
      college: { type: String, required: true, trim: true }
    }]
  }],
  eventStatus: [{
    eventName: { type: String, required: true },
    isPresent: { type: Boolean, default: false },
    paymentMethod: {
      type: String,
      enum: ['cash', 'online', null],
      default: null
    }
  }],
  registrationDate: { type: Date, default: Date.now }
});

const Registration = mongoose.model('Registration', registrationSchema);

const adminSessions = new Map();
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [token, expiry] of adminSessions) {
    if (expiry < now) adminSessions.delete(token);
  }
}

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};

  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    cleanExpiredSessions();
    const token = crypto.randomBytes(32).toString('hex');
    adminSessions.set(token, Date.now() + SESSION_DURATION_MS);
    return res.json({ success: true, token });
  }

  res.status(401).json({ error: 'Invalid username or password' });
});

app.post('/api/admin/logout', (req, res) => {
  const token = req.headers['admin-auth'];
  adminSessions.delete(token);
  res.json({ success: true });
});

const checkAdminAuth = (req, res, next) => {
  const token = req.headers['admin-auth'];
  const expiry = adminSessions.get(token);

  if (token && expiry && expiry > Date.now()) {
    next();
  } else {
    if (token) adminSessions.delete(token);
    res.status(401).json({ error: 'Unauthorized: Please log in again' });
  }
};

// Registration Endpoint
app.post('/api/register', upload.single('idPhoto'), async (req, res) => {
  try {
    let selectedEvents = req.body.selectedEvents;
    if (typeof selectedEvents === 'string') {
      try {
        selectedEvents = JSON.parse(selectedEvents);
      } catch {
        selectedEvents = [selectedEvents];
      }
    }

    const normalizedEmail = req.body.email?.trim().toLowerCase();

    const existingReg = normalizedEmail
      ? await Registration.findOne({
          email: { $regex: new RegExp(`^${normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
        })
      : null;

    if (existingReg) {
      const duplicateEvents = selectedEvents.filter(ev =>
        existingReg.selectedEvents.includes(ev)
      );

      if (duplicateEvents.length > 0) {
        if (req.file?.path) fs.unlink(req.file.path, () => {});
        return res.status(409).json({
          error: `You have already registered for: ${duplicateEvents.join(', ')}. Please choose different events, or contact us if this is a mistake.`
        });
      }
    }

    const emailIsValid = await hasValidMxRecord(req.body.email);
    if (!emailIsValid) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      return res.status(400).json({
        error: 'This email address doesn\'t look valid — please double check the domain (e.g. "@gmail.com") and try again.'
      });
    }

    let groupTeams = [];
    if (req.body.groupTeams) {
      try {
        groupTeams = JSON.parse(req.body.groupTeams);
      } catch {
        if (req.file?.path) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'Invalid team data submitted.' });
      }
    }

    for (const eventName of selectedEvents) {
      const config = EVENT_CONFIG[eventName];
      if (!config || config.type !== 'group') continue;

      const team = groupTeams.find(t => t.eventName === eventName);
      const members = team?.members || [];
      const sizeLabel = config.minTeammates === config.maxTeammates
        ? `${config.minTeammates}`
        : `${config.minTeammates}-${config.maxTeammates}`;

      if (members.length < config.minTeammates || members.length > config.maxTeammates) {
        if (req.file?.path) fs.unlink(req.file.path, () => {});
        return res.status(400).json({
          error: `"${eventName}" requires ${sizeLabel} teammate(s) besides yourself.`
        });
      }

      const teamEmailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const hasIncompleteMember = members.some(
        m => !m.name?.trim()
          || !/^[6-9]\d{9}$/.test(m.contact?.trim() || '')
          || !teamEmailRegex.test(m.email?.trim() || '')
          || !m.college?.trim()
      );
      if (hasIncompleteMember) {
        if (req.file?.path) fs.unlink(req.file.path, () => {});
        return res.status(400).json({
          error: `Please provide a valid name, email, 10-digit contact number (starting with 6, 7, 8, or 9), and college name for every teammate in "${eventName}".`
        });
      }
    }

    const validGroupTeams = groupTeams.filter(
      t => EVENT_CONFIG[t.eventName]?.type === 'group' && selectedEvents.includes(t.eventName)
    );

    const newReg = new Registration({
      ...req.body,
      email: normalizedEmail,
      selectedEvents,
      groupTeams: validGroupTeams,
      eventStatus: selectedEvents.map(eventName => ({ eventName, isPresent: false, paymentMethod: null })),
      idPhotoPath: req.file?.path
    });

    await newReg.save();
    res.status(201).json({ 
      success: true,
      message: 'Registration successful!',
      registrationId: newReg._id
    });
  } catch (error) {
    console.error('Registration Error:', error);

    if (req.file?.path) {
      fs.unlink(req.file.path, () => {});
    }

    if (error.code === 11000) {
      return res.status(409).json({ error: 'An account with this email has already registered.' });
    }

    if (error.name === 'ValidationError') {
      const message = Object.values(error.errors).map(e => e.message).join(', ');
      return res.status(400).json({ error: message });
    }

    if (error instanceof multer.MulterError) {
      return res.status(400).json({ error: error.message });
    }

    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// Admin Routes
app.get('/api/admin/registrations', checkAdminAuth, async (req, res) => {
  try {
    const registrations = await Registration.find().sort({ registrationDate: -1 }).lean();
    res.json(registrations);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch registrations' });
  }
});

app.get('/api/admin/registrations/event/:eventName', checkAdminAuth, async (req, res) => {
  try {
    const eventName = decodeURIComponent(req.params.eventName);
    const registrations = await Registration.find({ selectedEvents: eventName }).sort({ registrationDate: -1 }).lean();
    res.json(registrations);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch registrations for this event' });
  }
});

// Delete a registration (admin only)
app.delete('/api/admin/registrations/:id', checkAdminAuth, async (req, res) => {
  try {
    const registration = await Registration.findById(req.params.id);

    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    if (registration.idPhotoPath && fs.existsSync(registration.idPhotoPath)) {
      fs.unlink(registration.idPhotoPath, (err) => {
        if (err) console.error('Failed to delete ID photo file:', err);
      });
    }

    await Registration.findByIdAndDelete(req.params.id);

    res.json({ success: true, message: 'Registration deleted successfully' });
  } catch (error) {
    console.error('Delete Registration Error:', error);
    res.status(500).json({ error: 'Failed to delete registration' });
  }
});

// --- Public (no login) per-event coordinator routes ---
app.get('/api/event/:eventName/registrations', async (req, res) => {
  try {
    const eventName = decodeURIComponent(req.params.eventName);
    const registrations = await Registration.find({ selectedEvents: eventName }).sort({ registrationDate: -1 }).lean();
    res.json(registrations);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch registrations for this event' });
  }
});

app.put('/api/event/:eventName/attendance/:id', async (req, res) => {
  try {
    const eventName = decodeURIComponent(req.params.eventName);
    const isPresent = req.body.isPresent !== undefined ? req.body.isPresent : true;

    let updated = await Registration.findOneAndUpdate(
      { _id: req.params.id, 'eventStatus.eventName': eventName },
      { $set: { 'eventStatus.$.isPresent': isPresent } },
      { new: true }
    );

    if (!updated) {
      updated = await Registration.findOneAndUpdate(
        { _id: req.params.id, selectedEvents: eventName, 'eventStatus.eventName': { $ne: eventName } },
        { $push: { eventStatus: { eventName, isPresent, paymentMethod: null } } },
        { new: true }
      );
    }

    if (!updated) {
      return res.status(404).json({ error: 'Participant or event entry not found' });
    }

    res.json(updated);
  } catch (error) {
    console.error('Attendance Update Error:', error);
    res.status(500).json({ error: 'Attendance update failed' });
  }
});

app.put('/api/event/:eventName/payment/:id', async (req, res) => {
  try {
    const eventName = decodeURIComponent(req.params.eventName);
    const { paymentMethod } = req.body;
    if (!['cash', 'online', null].includes(paymentMethod)) {
      return res.status(400).json({ error: 'Invalid payment method' });
    }

    let updated = await Registration.findOneAndUpdate(
      { _id: req.params.id, 'eventStatus.eventName': eventName },
      { $set: { 'eventStatus.$.paymentMethod': paymentMethod } },
      { new: true }
    );

    if (!updated) {
      updated = await Registration.findOneAndUpdate(
        { _id: req.params.id, selectedEvents: eventName, 'eventStatus.eventName': { $ne: eventName } },
        { $push: { eventStatus: { eventName, isPresent: false, paymentMethod } } },
        { new: true }
      );
    }

    if (!updated) {
      return res.status(404).json({ error: 'Participant or event entry not found' });
    }

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Payment update failed' });
  }
});

app.put('/api/admin/attendance/:id', checkAdminAuth, async (req, res) => {
  try {
    const { eventName } = req.body;
    const isPresent = req.body.isPresent !== undefined ? req.body.isPresent : true;

    if (!eventName) {
      return res.status(400).json({ error: 'eventName is required' });
    }

    let updated = await Registration.findOneAndUpdate(
      { _id: req.params.id, 'eventStatus.eventName': eventName },
      { $set: { 'eventStatus.$.isPresent': isPresent } },
      { new: true }
    );

    if (!updated) {
      updated = await Registration.findOneAndUpdate(
        { _id: req.params.id, selectedEvents: eventName, 'eventStatus.eventName': { $ne: eventName } },
        { $push: { eventStatus: { eventName, isPresent, paymentMethod: null } } },
        { new: true }
      );
    }

    if (!updated) {
      return res.status(404).json({ error: 'Participant or event entry not found' });
    }

    res.json(updated);
  } catch (error) {
    console.error('Attendance Update Error:', error);
    res.status(500).json({ error: 'Attendance update failed' });
  }
});

app.put('/api/admin/payment/:id', checkAdminAuth, async (req, res) => {
  try {
    const { eventName, paymentMethod } = req.body;
    if (!eventName) {
      return res.status(400).json({ error: 'eventName is required' });
    }
    if (!['cash', 'online', null].includes(paymentMethod)) {
      return res.status(400).json({ error: 'Invalid payment method' });
    }

    let updated = await Registration.findOneAndUpdate(
      { _id: req.params.id, 'eventStatus.eventName': eventName },
      { $set: { 'eventStatus.$.paymentMethod': paymentMethod } },
      { new: true }
    );

    if (!updated) {
      updated = await Registration.findOneAndUpdate(
        { _id: req.params.id, selectedEvents: eventName, 'eventStatus.eventName': { $ne: eventName } },
        { $push: { eventStatus: { eventName, isPresent: false, paymentMethod } } },
        { new: true }
      );
    }

    if (!updated) {
      return res.status(404).json({ error: 'Participant or event entry not found' });
    }

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Payment update failed' });
  }
});

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    database: mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected',
    uptime: process.uptime()
  });
});

// Error Handling
app.use((err, req, res, next) => {
  console.error('Server Error:', err);
  if (err instanceof multer.MulterError || /image/i.test(err.message || '')) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: 'Internal server error' });
});

// Server Startup
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  connectDB();
  console.log(`🚀 Server running on port ${PORT}`);
});

// Graceful Shutdown
process.on('SIGTERM', () => {
  server.close(() => {
    mongoose.connection.close();
    console.log('Server stopped');
    process.exit(0);
  });
});
