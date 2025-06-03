// server.js (update)
const express = require('express');
const dotenv = require('dotenv');
const morgan = require('morgan');
const cors = require('cors');
const helmet = require('helmet');
const connectDB = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const taskRoutes = require('./routes/taskRoutes');
const eventRoutes = require('./routes/eventRoutes');
const invoiceRoutes = require('./routes/invoiceRoutes'); 
const chatRoutes = require('./routes/chatRoutes');
const eveDroppingRoutes = require('./routes/eveDroppingRoutes');
const errorMiddleware = require('./middlewares/errorMiddleware');

dotenv.config();

// Connect to database
connectDB();

const app = express();

// Middlewares
app.use(cors());
app.use(helmet());
app.use(morgan('dev'));
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/chat', chatRoutes); 
app.use('/api/invoices', invoiceRoutes);
app.use('/api/eve-dropping', eveDroppingRoutes);
// Error handling middleware
app.use(errorMiddleware);

const PORT = process.env.PORT || 5002;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});