

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();

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

    const newReg = new Registration({
      ...req.body,
      selectedEvents,
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
