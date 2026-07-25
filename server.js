

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

// Checks that an email's domain actually has mail servers configured,
// catching fake/typo domains (e.g. "gamis.com") at registration time.
// Note: this confirms the domain can receive mail — it does NOT confirm
// the specific mailbox exists. That would need a real verification
// email/OTP flow, which is a bigger feature if you want it later.
// Mirrors the event list in RegistrationForm.jsx. Used to validate group
// team sizes server-side too, since client-side validation alone can be
// bypassed by anyone calling the API directly.
const EVENT_CONFIG = {
  'PROMPT ARENA - Prompt Engineering': { type: 'individual' },
  'VISION CRAFT - Prompt to Website': { type: 'group', minTeammates: 1, maxTeammates: 1 },
  'CYPHRA - Debugging': { type: 'individual' },
  'VESTIGE ALIBI - Crime Investigation': { type: 'group', minTeammates: 1, maxTeammates: 1 },
  'SYNTH & STEEL - Idea Presentation': { type: 'group', minTeammates: 1, maxTeammates: 2 },
  'THE OBSIDIAN TRAIL - Treasure Hunt': { type: 'group', minTeammates: 2, maxTeammates: 2 },
  'MEMORA - Meme Creation': { type: 'individual' }
};

async function hasValidMxRecord(email) {
  const domain = email?.split('@')[1];
  if (!domain) return false;
  try {
    const records = await Promise.race([
      dns.resolveMx(domain),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), 3000))
    ]);
    // A "null MX" record (empty exchange, e.g. RFC 7505) means the domain
    // explicitly does NOT accept mail — don't count that as valid.
    return records.some(r => r.exchange && r.exchange !== '.');
  } catch (err) {
    // If DNS itself timed out/errored (vs. a real "no such domain" answer),
    // fail open rather than blocking a real registration during a slow moment.
    if (err.message === 'DNS timeout') {
      console.warn(`MX lookup timed out for domain "${domain}" — allowing registration through`);
      return true;
    }
    return false;
  }
}

// Verify MongoDB URI is set
if (!process.env.MONGODB_URI) {
  console.error('❌ FATAL ERROR: MONGODB_URI not configured in environment variables');
  process.exit(1);
}

// Verify Admin credentials are set
if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
  console.error('❌ FATAL ERROR: ADMIN_USERNAME / ADMIN_PASSWORD not configured in environment variables');
  process.exit(1);
}

// Create 'uploads' directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Enhanced CORS Configuration
// Extra allowed origins can be added without a code change via the
// FRONTEND_URL env var (comma-separated if you have more than one).
const extraOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const staticAllowedOrigins = [
  'https://golden-frangollo-580ffa.netlify.app',
  'http://localhost:5173',
  'http://localhost:3000', // For local development
  ...extraOrigins
];

// Netlify gives every deploy preview / branch deploy its own subdomain,
// e.g. https://<deploy-id>--golden-frangollo-580ffa.netlify.app
// This regex allows any of those for the same site, not just production.
const netlifyPreviewPattern = /^https:\/\/[a-z0-9-]+--golden-frangollo-580ffa\.netlify\.app$/;

app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser requests (no origin header, e.g. curl/health checks)
    if (!origin) return callback(null, true);

    if (staticAllowedOrigins.includes(origin) || netlifyPreviewPattern.test(origin)) {
      return callback(null, true);
    }

    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'admin-auth'],
  credentials: true
}));

// Middlewares
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/uploads', express.static(uploadsDir));

// Multer Configuration (unchanged)
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
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// MongoDB Connection with retry logic
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

// Updated Mongoose Schema with Payment Tracking
const registrationSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { 
    type: String, 
    required: true,
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
      contact: {
        type: String,
        required: true,
        validate: {
          validator: v => /^[6-9]\d{9}$/.test(v),
          message: props => `${props.value} is not a valid Indian number!`
        }
      }
    }]
  }],
  isPresent: { type: Boolean, default: false },
  paymentMethod: { 
    type: String, 
    enum: ['cash', 'online', null],
    default: null 
  },
  registrationDate: { type: Date, default: Date.now }
});

const Registration = mongoose.model('Registration', registrationSchema);

// --- Admin Auth: real login with token-based sessions ---
// In-memory store of valid admin session tokens -> expiry timestamp.
// (Fine for a single-instance small event app. Tokens reset on server
// restart, and this won't work if you ever scale to multiple server
// instances — swap for Redis/JWT if that becomes a need.)
const adminSessions = new Map();
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000; // 12 hours

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
    if (token) adminSessions.delete(token); // clean up expired token
    res.status(401).json({ error: 'Unauthorized: Please log in again' });
  }
};

// Registration Endpoint (unchanged)
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

      const hasIncompleteMember = members.some(
        m => !m.name?.trim() || !/^[6-9]\d{9}$/.test(m.contact?.trim() || '')
      );
      if (hasIncompleteMember) {
        if (req.file?.path) fs.unlink(req.file.path, () => {});
        return res.status(400).json({
          error: `Please provide a valid name and 10-digit contact number for every teammate in "${eventName}".`
        });
      }
    }

    // Only keep team data for events that are actually marked as group events,
    // so stray/spoofed entries for individual events are ignored.
    const validGroupTeams = groupTeams.filter(
      t => EVENT_CONFIG[t.eventName]?.type === 'group' && selectedEvents.includes(t.eventName)
    );

    const newReg = new Registration({
      ...req.body,
      selectedEvents,
      groupTeams: validGroupTeams,
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

    // Clean up the uploaded file if saving the registration failed,
    // so we don't leave orphaned images on disk.
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
    const registrations = await Registration.find().sort({ registrationDate: -1 });
    res.json(registrations);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch registrations' });
  }
});

// REPLACE THIS IN YOUR SERVER.JS
app.put('/api/admin/attendance/:id', checkAdminAuth, async (req, res) => {
  try {
    // This supports both a JSON body { isPresent: true } AND a fallback true assessment
    const isPresent = req.body.isPresent !== undefined ? req.body.isPresent : true;

    const updated = await Registration.findByIdAndUpdate(
      req.params.id,
      { isPresent: isPresent },
      { new: true }
    );
    
    if (!updated) {
      return res.status(404).json({ error: 'Participant not found' });
    }
    
    res.json(updated);
  } catch (error) {
    console.error('Attendance Update Error:', error);
    res.status(500).json({ error: 'Attendance update failed' });
  }
});

// NEW: Payment Status Endpoint
app.put('/api/admin/payment/:id', checkAdminAuth, async (req, res) => {
  try {
    const { paymentMethod } = req.body;
    if (!['cash', 'online', null].includes(paymentMethod)) {
      return res.status(400).json({ error: 'Invalid payment method' });
    }

    const updated = await Registration.findByIdAndUpdate(
      req.params.id,
      { paymentMethod },
      { new: true }
    );
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
