require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();

// Create 'uploads' directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// CORS Configuration
app.use(cors({
  origin: ['https://golden-frangollo-580ffa.netlify.app/', 'http://localhost:5173'],
  methods: ['GET', 'POST', 'PUT'],
  credentials: true
}));

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadsDir));

// Multer Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext);
    const uniqueName = `${base}-${Date.now()}${ext}`;
    cb(null, uniqueName);
  }
});

const upload = multer({ storage });

// MongoDB Connection with improved configuration
const connectWithRetry = () => {
  console.log('Attempting MongoDB connection...');
  mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 10000,  // Increased timeout
    socketTimeoutMS: 45000,          // Added socket timeout
    connectTimeoutMS: 10000,         // Added connection timeout
    retryWrites: true,
    w: 'majority'
  })
  .then(() => {
    console.log('✅ MongoDB connected successfully');
    // Verify connection is ready
    const db = mongoose.connection;
    db.on('error', console.error.bind(console, 'MongoDB connection error:'));
    db.once('open', () => {
      console.log('MongoDB connection is ready');
    });
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    console.log('Retrying in 5 seconds...');
    setTimeout(connectWithRetry, 5000);
  });
};

connectWithRetry();

// Mongoose Schemas
const registrationSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  contact: { type: String, required: true },
  college: { type: String, required: true },
  course: { type: String, required: true },
  sem: { type: String, required: true },
  selectedEvents: { type: [String], required: true },
  idPhotoPath: { type: String },
  isPresent: { type: Boolean, default: false },
  registrationDate: { type: Date, default: Date.now }
});

const Registration = mongoose.model('Registration', registrationSchema);

// Routes

// Registration Endpoint
app.post('/api/register', upload.single('idPhoto'), async (req, res) => {
  try {
    const {
      name,
      email,
      contact,
      college,
      course,
      sem,
      selectedEvents
    } = req.body;

    if (!selectedEvents || (Array.isArray(selectedEvents) ? selectedEvents.length === 0 : false)) {
      return res.status(400).json({ error: 'Select at least one event' });
    }

    const selectedEventsArray = Array.isArray(selectedEvents)
      ? selectedEvents
      : [selectedEvents];

    const newRegistration = new Registration({
      name,
      email,
      contact,
      college,
      course,
      sem,
      selectedEvents: selectedEventsArray,
      idPhotoPath: req.file ? req.file.path : null
    });

    await newRegistration.save();
    res.status(201).json({ message: 'Registration successful!' });

  } catch (error) {
    console.error('Registration error:', error);

    if (error.code === 11000) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: 'Validation failed', details: error.message });
    }

    return res.status(500).json({ error: 'Server error' });
  }
});

// Get All Registrations (Admin)
app.get('/api/admin/registrations', async (req, res) => {
  try {
    const registrations = await Registration.find().sort({ registrationDate: -1 });
    res.json(registrations);
  } catch (error) {
    console.error('Error fetching registrations:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update Attendance Status
app.put('/api/admin/attendance/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { isPresent } = req.body;

    const updatedReg = await Registration.findByIdAndUpdate(
      id,
      { isPresent },
      { new: true }
    );

    if (!updatedReg) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    res.json(updatedReg);
  } catch (error) {
    console.error('Error updating attendance:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Events List
app.get('/api/admin/events', async (req, res) => {
  try {
    const registrations = await Registration.find();
    const events = [...new Set(registrations.flatMap(reg => reg.selectedEvents))];
    res.json(events);
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Health Check Endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    database: mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected',
    timestamp: new Date()
  });
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`MongoDB readyState: ${mongoose.connection.readyState}`);
});
