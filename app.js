// app.js
const express = require('express');
const dotenv = require('dotenv');
const morgan = require('morgan');
const cors = require('cors');
const helmet = require('helmet');
const connectDB = require('./config/db');
const fs = require('fs');
const path = require('path');

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { handleWhatsAppMessage } = require('./controllers/whatsappController');

// Routes
const authRoutes = require('./routes/authRoutes');
const taskRoutes = require('./routes/taskRoutes');
const eventRoutes = require('./routes/eventRoutes');
const invoiceRoutes = require('./routes/invoiceRoutes');
const chatRoutes = require('./routes/chatRoutes');
const whatsappRoutes = require('./routes/whatsappRoutes');
const eveDroppingRoutes = require('./routes/eveDroppingRoutes');
const xeroRoutes = require('./routes/xeroRoutes');

// Middleware
const errorMiddleware = require('./middlewares/errorMiddleware');

dotenv.config();
connectDB();

const app = express();

// Middlewares
app.use(cors());
app.use(helmet());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Base URL route - Welcome message
app.get('/', (req, res) => {
  res.json({
    message: '🚀 Server is running successfully!',
    status: 'online',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      tasks: '/api/tasks',
      events: '/api/events',
      chat: '/api/chat',
      invoices: '/api/invoices',
      whatsapp: '/api/whatsapp',
      'eve-dropping': '/api/eve-dropping',
      xero: '/api/xero',
      health: '/health'
    }
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/eve-dropping', eveDroppingRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/xero', xeroRoutes);

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Error handling
app.use(errorMiddleware);

const PORT = process.env.PORT || 5002;

// Start regular HTTP server only
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Visit: http://localhost:${PORT}`);
});

// ======================
// ✅ WhatsApp Web Setup
// ======================
const sessionPath = path.join(__dirname, 'whatsapp-session');
if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: sessionPath }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env.CHROMIUM_PATH || undefined
  },
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/pedroslopez/whatsapp-web.js/Releases/latest'
  }
});

client.on('qr', qr => {
  console.log('📱 Scan the WhatsApp QR code below:');
  qrcode.generate(qr, { small: true });
});
client.on('loading_screen', (percent, message) => {
  console.log(`⏳ Loading: ${percent}% — ${message}`);
});
client.on('authenticated', () => {
  console.log('🔐 Authenticated. Finishing sync…');
});
client.on('ready', () => {
  console.log('✅ WhatsApp client is ready!');
});
client.on('change_state', state => {
  console.log('🔁 State:', state);
});
client.on('auth_failure', (msg) => {
  console.error('❌ Authentication failure:', msg);
});
client.on('disconnected', (reason) => {
  console.warn('⚠️ WhatsApp client disconnected:', reason);
  setTimeout(() => client.initialize(), 5000);
});

client.on('message', handleWhatsAppMessage);

let readyFlag = false;
client.on('ready', () => { readyFlag = true; });
setTimeout(() => {
  if (!readyFlag) {
    console.error('⛔ Pairing timed out. Check Chromium deps, session folder perms, phone online, and server time.');
  }
}, 120000);

client.initialize();