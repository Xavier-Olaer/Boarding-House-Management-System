const express = require('express');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// Load environment variables
dotenv.config();

const chatRoutes = require('./chat');
const authRoutes = require('./auth');  
const landlordRoutes = require('./landlordRoutes');
const tenantRoutes = require('./tenantRoutes'); 
const cronJobs = require('./cronJobs');

const app = express();
const PORT = process.env.PORT || 5000;
const server = http.createServer(app);

// Create a database connection pool at the top level
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Global error logger
const logError = (err, context = '') => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ${context}:`, {
        message: err.message,
        stack: err.stack,
        context
    });
};

// Global async handler
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
        logError(err, req.path);
        next(err);
    });
};

// Configure CORS
const corsOptions = {
    origin: process.env.FRONTEND_URL || process.env.RAILWAY_STATIC_URL || "*",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    credentials: true,
    optionsSuccessStatus: 200
};

// Configure Socket.IO with error handling
const io = new Server(server, {
    cors: corsOptions
});

io.on('error', (err) => {
    logError(err, 'Socket.IO Error');
});

// MIDDLEWARE
app.use(express.json());
app.use(cors(corsOptions));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Request logging middleware
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path}`);
    next();
});

// Error handling middleware
app.use((err, req, res, next) => {
    logError(err, `${req.method} ${req.path}`);
    
    // Don't expose error details in production
    const errorResponse = {
        error: 'Something went wrong!',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error',
        requestId: new Date().getTime() // Helpful for tracking errors
    };

    if (process.env.NODE_ENV === 'development') {
        errorResponse.stack = err.stack;
    }

    res.status(err.status || 500).json(errorResponse);
});

// ROUTES with error handling
app.use('/api', asyncHandler(authRoutes));
app.use('/api/landlord', asyncHandler(landlordRoutes));
app.use('/api/tenant', asyncHandler(tenantRoutes));
app.use('/api/chat', asyncHandler(chatRoutes));

// Initialize cron jobs with error handling
try {
    const { initializeCronJobs } = require('./cronJobs');
    initializeCronJobs();
} catch (err) {
    logError(err, 'Cron Jobs Initialization');
}

// Health check endpoint for Railway
app.get('/health', asyncHandler(async (req, res) => {
    // Check database connection
    try {
        const db = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME
        });
        await db.ping();
        await db.end();
        
        res.status(200).json({ 
            status: 'healthy',
            database: 'connected',
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        logError(err, 'Health Check');
        res.status(500).json({ 
            status: 'unhealthy',
            database: 'disconnected',
            timestamp: new Date().toISOString()
        });
    }
}));

// Debug endpoint (only in development)
if (process.env.NODE_ENV === 'development') {
    app.get('/debug', (req, res) => {
        res.json({
            environment: process.env.NODE_ENV,
            nodeVersion: process.version,
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage(),
            timestamp: new Date().toISOString()
        });
    });
}

// Root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// SOCKET.IO with error handling
io.on('connection', (socket) => {
    console.log(`[${new Date().toISOString()}] Socket connected: ${socket.id}`);
    
    socket.on('error', (err) => {
        logError(err, `Socket ${socket.id} Error`);
    });

    socket.on('chat message', (msg) => {
        try {
            console.log(`[${new Date().toISOString()}] Message from ${socket.id}:`, msg);
            io.emit('chat message', msg);
        } catch (err) {
            logError(err, 'Socket Chat Message');
        }
    });

    socket.on('disconnect', () => {
        console.log(`[${new Date().toISOString()}] Socket disconnected: ${socket.id}`);
    });
});

// Get all users
app.get('/users', (req, res) => {
    const sql = 'SELECT * FROM users';
    pool.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch users' });
        res.json(results);
    });
});

// Get a user by ID
app.get('/users/:user_id', (req, res) => {
    const { user_id } = req.params;
    const sql = 'SELECT * FROM users WHERE user_id = ?';
    pool.query(sql, [user_id], (err, result) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch user' });
        if (result.length === 0) return res.status(404).json({ error: 'User not found' });
        res.json(result[0]);
    });
});

// Create a new user
app.post('/users', (req, res) => {
    const { full_name, gender, contact_number, email, password, role } = req.body;

    // Ensure all required fields are provided
    if (!full_name || !gender || !contact_number_number || !email || !password || !role) {
        return res.status(400).json({ error: 'Missing required fields: full_name, gender, contact_number, email, password, role' });
    }

    // SQL query to insert new user
    const sql = 'INSERT INTO users (full_name, gender, contact_number, email, password, role) VALUES (?, ?, ?, ?, ?, ?)';

    // Execute the query
    pool.query(sql, [full_name, gender, contact_number, email, password, role], (err, result) => {
        if (err) {
            console.error('Error:', err); // Log the error details
            return res.status(500).json({ error: 'Failed to create user', details: err.message });
        }

        // Success response
        res.status(201).json({ message: 'User created successfully', user_id: result.insertId });
    });
});

// Update a user by ID
app.put('/users/:user_id', (req, res) => {
    const { user_id } = req.params;
    const { full_name, email, role } = req.body;

    if (!full_name || !email || !role) {
        return res.status(400).json({ error: 'Missing required fields: full_name, email, role' });
    }

    const sql = 'UPDATE users SET full_name = ?, email = ?, role = ? WHERE user_id = ?';
    pool.query(sql, [full_name, email, role, user_id], (err, result) => {
        if (err) return res.status(500).json({ error: 'Failed to update user' });
        if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ message: 'User updated successfully' });
    });
});

// Delete a user by ID
app.delete('/users/:user_id', (req, res) => {
    const { user_id } = req.params;
    const sql = 'DELETE FROM users WHERE user_id = ?';
    pool.query(sql, [user_id], (err, result) => {
        if (err) return res.status(500).json({ error: 'Failed to delete user' });
        if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ message: 'User deleted successfully' });
    });
});

// **FOR RENT DUE**

// **GET Rent Due Status (Optional tenant_id)**
app.get('/rent_due/:tenant_id?', (req, res) => {
    const tenant_id = req.params.tenant_id;

    let sql;
    let params = [];

    if (tenant_id) {
        // If tenant_id is provided, fetch the rent due status for that tenant
        sql = `
            SELECT rent_due.*, tenants.tenant_id, users.full_name
            FROM rent_due
            JOIN tenants ON rent_due.tenant_id = tenants.tenant_id
            JOIN users ON tenants.user_id = users.user_id
            WHERE rent_due.tenant_id = ?
        `;
        params = [tenant_id];
    } else {
        // If no tenant_id is provided, fetch all rent due records
        sql = `
            SELECT rent_due.*, tenants.tenant_id, users.full_name
            FROM rent_due
            JOIN tenants ON rent_due.tenant_id = tenants.tenant_id
            JOIN users ON tenants.user_id = users.user_id
        `;
    }

    pool.query(sql, params, (err, result) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch rent due status' });
        if (result.length === 0) return res.status(404).json({ error: 'No rent due records found' });
        res.json(result);
    });
});

// **POST: Add Rent Due Record**
app.post('/rent_due', (req, res) => {
    const { tenant_id, amount_due, due_date } = req.body;
    if (!tenant_id || !amount_due || !due_date) {
        return res.status(400).json({ error: 'Missing required fields: tenant_id, amount_due, due_date' });
    }

    const sql = `INSERT INTO rent_due (tenant_id, amount_due, due_date) VALUES (?, ?, ?)`;

    pool.query(sql, [tenant_id, amount_due, due_date], (err, result) => {
        if (err) return res.status(500).json({ error: 'Failed to create rent due record' });
        res.status(201).json({ message: 'Rent due record created successfully', rent_due_id: result.insertId });
    });
});

app.put('/rent_due/:rent_due_id', (req, res) => {
    const { rent_due_id } = req.params;
    const { status } = req.body;

    // Validate status field
    if (status && !['paid', 'pending', 'overdue'].includes(status)) {
        return res.status(400).json({ error: 'Invalid rent due status' });
    }

    // Determine the paid status based on provided status
    let paidStatus = 0;  // Default: unpaid
    if (status === 'paid') {
        paidStatus = 1;  // Rent is paid
    }

    const sql = `UPDATE rent_due SET paid = ?, status = ? WHERE rent_due_id = ?`;

    // Check if rent is overdue by comparing current date to the due_date
    const currentDate = new Date().toISOString().split('T')[0]; // Get current date in YYYY-MM-DD format
    let calculatedStatus = status || 'pending';
    if (!status && currentDate > req.body.due_date) {
        calculatedStatus = 'overdue';
    }

    pool.query(sql, [paidStatus, calculatedStatus, rent_due_id], (err, result) => {
        if (err) return res.status(500).json({ error: 'Failed to update rent due record' });
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Rent due record not found' });
        res.json({ message: 'Rent due record updated successfully' });
    });
});

//DELETE: Delete Rent Due Record
app.delete('/rent_due/:rent_due_id', (req, res) => {
    const { rent_due_id } = req.params;
    const sql = `DELETE FROM rent_due WHERE rent_due_id = ?`;

    pool.query(sql, [rent_due_id], (err, result) => {
        if (err) return res.status(500).json({ error: 'Failed to delete rent due record' });
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Rent due record not found' });
        res.json({ message: 'Rent due record deleted successfully' });
    });
});

// **FOR PAYMENTS**

//POST: Create Payment and Update Rent Due
app.post('/payments', (req, res) => {
    const { tenant_id, amount, payment_method, payment_reference, rent_due_id } = req.body;
    
    // Validate required fields
    if (!tenant_id || !amount || !payment_method || !payment_reference || !rent_due_id) {
        return res.status(400).json({ error: 'Missing required fields: tenant_id, amount, payment_method, payment_reference, rent_due_id' });
    }

    // 1. Insert a new payment record
    const payment_sql = `INSERT INTO payments (tenant_id, paid_at, amount, method, payment_reference, rent_due_id) 
                         VALUES (?, NOW(), ?, ?, ?, ?)`;

    pool.query(payment_sql, [tenant_id, amount, payment_method, payment_reference, rent_due_id], (err, result) => {
        if (err) return res.status(500).json({ error: 'Failed to create payment record' });

        // 2. Update the rent due record
        const update_rent_due_sql = `
            UPDATE rent_due
            SET paid_amount = paid_amount + ?, 
                status = CASE
                    WHEN paid_amount + ? >= amount_due THEN 'paid'
                    WHEN due_date < CURDATE() AND paid_amount + ? < amount_due THEN 'overdue'
                    ELSE 'pending'
                END
            WHERE rent_due_id = ?
        `;

        pool.query(update_rent_due_sql, [amount, amount, amount, rent_due_id], (err, updateResult) => {
            if (err) return res.status(500).json({ error: 'Failed to update rent due record' });

            // Check if the update affected any rows, if not return a 404
            if (updateResult.affectedRows === 0) {
                return res.status(404).json({ error: 'Rent due record not found' });
            }

            res.status(201).json({ message: 'Payment recorded and rent due updated successfully' });
        });
    });
});

//GET: Get All Payments
app.get('/payments', (req, res) => {
    const sql = `
        SELECT payments.*, users.full_name
        FROM payments
        JOIN tenants ON payments.tenant_id = tenants.tenant_id
        JOIN users ON tenants.user_id = users.user_id
    `;

    pool.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch payments' });
        res.json(results);
    });
});

//GET: Get Payment by ID
app.get('/payments/:payment_id', (req, res) => {
    const { payment_id } = req.params;
    const sql = `
        SELECT payments.*, users.full_name
        FROM payments
        JOIN tenants ON payments.tenant_id = tenants.tenant_id
        JOIN users ON tenants.user_id = users.user_id
        WHERE payments.payment_id = ?
    `;

    pool.query(sql, [payment_id], (err, result) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch payment' });
        if (result.length === 0) return res.status(404).json({ error: 'Payment not found' });
        res.json(result[0]);
    });
});

//PUT: Update Payment Status
app.put('/payments/:payment_id', (req, res) => {
    const { payment_id } = req.params;  
    const { status } = req.body;

    // Only allow "paid" or "unpaid" for example
    const validStatuses = ['paid', 'unpaid'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid payment status' });
    }

    // Update payment status (if using status column)
    const sql = `UPDATE payments SET status = ? WHERE payment_id = ?`;

    pool.query(sql, [status, payment_id], (err, result) => {
        if (err) return res.status(500).json({ error: 'Failed to update payment status' });
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Payment not found' });
        res.json({ message: 'Payment status updated successfully' });
    });
});

//**FOR MAINTENACE REQUESTS**

// Get all maintenance requests
app.get('/maintenance_request', (req, res) => {
    const sql = `
        SELECT mr.*, u.full_name, u.gender, r.room_number AS room_label 
        FROM maintenance_requests mr
        JOIN tenants t ON mr.tenant_id = t.tenant_id
        JOIN users u ON t.user_id = u.user_id
        JOIN rooms r ON t.room_id = r.room_id
    `;

    pool.query(sql, (err, results) => {
        if (err) {
            console.error('Error fetching requests:', err);
            return res.status(500).json({ error: 'Failed to fetch maintenance requests' });
        }

        // Add salutation based on gender
        const requestsWithSalutation = results.map(request => {
            if (request.gender === 'Male') {
                request.salutation = 'Mr.';
            } else if (request.gender === 'Female') {
                request.salutation = 'Ms.';
            } else {
                request.salutation = 'Mx.'; // For 'Other' gender
            }
            return request;
        });

        res.json(requestsWithSalutation);
    });
});

// Update maintenance request status and notify tenant
app.put('/maintenance_request/:id', (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    // Validate the status
    const validStatuses = ['pending', 'in_progress', 'completed', 'rejected'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status value' });
    }

    // Update the request status
    const sql = `UPDATE maintenance_requests SET status = ? WHERE request_id = ?`;

    pool.query(sql, [status, id], (err, result) => {
        if (err) {
            console.error('Error updating status:', err);
            return res.status(500).json({ error: 'Failed to update status' });
        }

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Request not found' });
        }

        // After updating the status, send notification to tenant
        const notifyMessage = `The status of your maintenance request has been updated to '${status}'`;

        // Get tenant user_id by request_id
        const getTenantSql = `SELECT t.user_id FROM maintenance_requests mr
                             JOIN tenants t ON mr.tenant_id = t.tenant_id
                             WHERE mr.request_id = ?`;

        pool.query(getTenantSql, [id], (err, tenantResult) => {
            if (err) {
                console.error('Error fetching tenant info:', err);
                return res.status(500).json({ error: 'Failed to notify tenant' });
            }

            if (tenantResult.length === 0) {
                return res.status(404).json({ error: 'Tenant not found for this request' });
            }

            const tenantUserId = tenantResult[0].user_id;

            // Insert a new notification for the tenant
            const insertNotificationSql = `INSERT INTO notifications (user_id, content) VALUES (?, ?)`;

            pool.query(insertNotificationSql, [tenantUserId, notifyMessage], (err) => {
                if (err) {
                    console.error('Error sending notification:', err);
                    return res.status(500).json({ error: 'Failed to send notification' });
                }

                res.json({ message: `Request updated to '${status}' and tenant notified.` });
            });
        });
    });
});

// Start server with error handling
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[${new Date().toISOString()}] Server started:`);
    console.log(`- Port: ${PORT}`);
    console.log(`- Environment: ${process.env.NODE_ENV}`);
    console.log(`- Node version: ${process.version}`);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    logError(err, 'Uncaught Exception');
    // Graceful shutdown
    server.close(() => {
        process.exit(1);
    });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    logError(reason, 'Unhandled Rejection');
});

