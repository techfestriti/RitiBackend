require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();

// Verify MongoDB URI is set
if (!process.env.MONGODB_URI) {
  console.error('❌ FATAL ERROR: MONGODB_URI not configured in environment variables');
  process.exit(1);
}

// Create 'uploads' directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Enhanced CORS Configuration
app.use(cors({
  origin: [
    'https://golden-frangollo-580ffa.netlify.app',
    'http://localhost:5173',
    'http://localhost:3000' // For local development
  ],
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
    unique: true,
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

// Enhanced Authentication Middleware
const checkAdminAuth = (req, res, next) => {
  const authHeader = req.headers['admin-auth'];
  if (authHeader === 'true') {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized: Invalid admin token' });
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
    // ... (keep existing error handling)
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

app.put('/api/admin/attendance/:id', checkAdminAuth, async (req, res) => {
  try {
    const updated = await Registration.findByIdAndUpdate(
      req.params.id,
      { isPresent: req.body.isPresent },
      { new: true }
    );
    res.json(updated);
  } catch (error) {
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
