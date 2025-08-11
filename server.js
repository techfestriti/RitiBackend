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

// Improved CORS Configuration
app.use(cors({
  origin: [
    'https://golden-frangollo-580ffa.netlify.app',
    'http://localhost:5173'
  ],
  methods: ['GET', 'POST', 'PUT'],
  credentials: true
}));

// Middlewares
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/uploads', express.static(uploadsDir));

// Enhanced Multer Configuration with file filtering
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

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG, and JPG are allowed.'), false);
  }
};

const upload = multer({ 
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// MongoDB Connection with better error handling and retry logic
const mongooseOptions = {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000,
  connectTimeoutMS: 30000,
  retryWrites: true,
  w: 'majority',
  retryAttempts: 5,
  retryDelay: 1000
};

const connectWithRetry = () => {
  console.log('Attempting MongoDB connection...');
  mongoose.connect(process.env.MONGODB_URI, mongooseOptions)
    .then(() => {
      console.log('✅ MongoDB connected successfully');
      mongoose.connection.on('error', err => {
        console.error('MongoDB connection error:', err);
      });
    })
    .catch(err => {
      console.error('❌ MongoDB connection error:', err.message);
      console.log('Retrying in 5 seconds...');
      setTimeout(connectWithRetry, 5000);
    });
};

connectWithRetry();

// Enhanced Mongoose Schema with validation
const registrationSchema = new mongoose.Schema({
  name: { 
    type: String, 
    required: [true, 'Name is required'],
    trim: true
  },
  email: { 
    type: String, 
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    validate: {
      validator: function(v) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
      },
      message: props => `${props.value} is not a valid email address!`
    }
  },
  contact: { 
    type: String, 
    required: [true, 'Contact number is required'],
    validate: {
      validator: function(v) {
        return /^[6-9]\d{9}$/.test(v);
      },
      message: props => `${props.value} is not a valid Indian phone number!`
    }
  },
  college: { 
    type: String, 
    required: [true, 'College name is required'],
    trim: true
  },
  course: { 
    type: String, 
    required: [true, 'Course is required'],
    trim: true
  },
  sem: { 
    type: String, 
    required: [true, 'Semester is required'],
    trim: true
  },
  selectedEvents: { 
    type: [String], 
    required: [true, 'At least one event must be selected'],
    validate: {
      validator: function(v) {
        return v.length > 0;
      },
      message: props => 'At least one event must be selected'
    }
  },
  idPhotoPath: { 
    type: String,
    trim: true
  },
  isPresent: { 
    type: Boolean, 
    default: false 
  },
  registrationDate: { 
    type: Date, 
    default: Date.now 
  }
});

const Registration = mongoose.model('Registration', registrationSchema);

// Enhanced Registration Endpoint
app.post('/api/register', upload.single('idPhoto'), async (req, res) => {
  try {
    // Parse selectedEvents if it's a string (for form-data)
    let selectedEvents = req.body.selectedEvents;
    if (typeof selectedEvents === 'string') {
      try {
        selectedEvents = JSON.parse(selectedEvents);
      } catch (e) {
        selectedEvents = [selectedEvents];
      }
    }

    // Validate required fields
    const requiredFields = ['name', 'email', 'contact', 'college', 'course', 'sem'];
    const missingFields = requiredFields.filter(field => !req.body[field]);
    
    if (missingFields.length > 0) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        missingFields
      });
    }

    // Validate at least one event is selected
    if (!selectedEvents || selectedEvents.length === 0) {
      return res.status(400).json({ error: 'Select at least one event' });
    }

    const newRegistration = new Registration({
      name: req.body.name,
      email: req.body.email,
      contact: req.body.contact,
      college: req.body.college,
      course: req.body.course,
      sem: req.body.sem,
      selectedEvents,
      idPhotoPath: req.file ? req.file.path : null
    });

    await newRegistration.save();
    
    return res.status(201).json({ 
      success: true,
      message: 'Registration successful!',
      registrationId: newRegistration._id
    });

  } catch (error) {
    console.error('Registration error:', error);

    // Handle duplicate key error (email)
    if (error.code === 11000) {
      return res.status(409).json({ 
        error: 'Email already registered',
        details: 'This email address is already in use'
      });
    }

    // Handle validation errors
    if (error.name === 'ValidationError') {
      const errors = {};
      Object.keys(error.errors).forEach(key => {
        errors[key] = error.errors[key].message;
      });
      return res.status(400).json({ 
        error: 'Validation failed',
        details: errors
      });
    }

    // Handle file upload errors
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ 
          error: 'File too large',
          details: 'Maximum file size is 5MB'
        });
      }
      return res.status(400).json({ 
        error: 'File upload error',
        details: error.message
      });
    }

    // Handle other errors
    return res.status(500).json({ 
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Other routes remain the same...

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: 'An unexpected error occurred'
  });
});

// Start Server with better error handling
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`MongoDB readyState: ${mongoose.connection.readyState}`);
});

// Handle server errors
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use`);
    process.exit(1);
  } else {
    console.error('Server error:', error);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down server...');
  server.close(() => {
    mongoose.connection.close(false, () => {
      console.log('Server and MongoDB connection closed');
      process.exit(0);
    });
  });
});
