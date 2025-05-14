require('dotenv').config();
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { body, validationResult } = require('express-validator');

// Signup Route
router.post('/signup', 
  body('email').isEmail().withMessage('Invalid email address.'),
  async (req, res) => {

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

  const { full_name, gender, contact_number, email, password, role } = req.body;

  if (!full_name || !gender || !contact_number || !email || !password || !role) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const validGenders = ['male', 'female', 'other'];

  if (!validGenders.includes(gender.toLowerCase())) {
    return res.status(400).json({ error: 'Invalid gender value.' });
  }

  const validRoles = ['tenant', 'landlord'];
  if (!validRoles.includes(role.toLowerCase())) {
    return res.status(400).json({ error: 'Invalid role selected.' });
  }

  try {
    const [existing] = await db.execute('SELECT user_id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Email already exists. Please use a different one.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const sql = `
      INSERT INTO users (full_name, gender, contact_number, email, password, role)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    await db.execute(sql, [full_name, gender.toLowerCase(), contact_number, email, hashedPassword, role.toLowerCase()]);

    res.status(201).json({ message: 'Signup successful!' });
  } catch (error) {
    console.error('Signup Error:', error);
    res.status(500).json({ error: 'Signup failed. Please try again later.' });
  }
});

// Login Route
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    // Get user with role
    const [[user]] = await db.query(
      'SELECT * FROM users WHERE email = ?',
      [email]
    );

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check password
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Initialize tenant variable
    let tenant = null;

    // If user is a tenant, check if they're blocked
    if (user.role === 'tenant') {
      // Get tenant info including blocking status
      [[tenant]] = await db.query(`
        SELECT 
          t.tenant_id,
          t.blocked_until,
          t.manually_unblocked,
          t.room_id
        FROM tenants t
        WHERE t.user_id = ?
      `, [user.user_id]);

      if (tenant) {
        // Check if blocked and not manually unblocked
        const now = new Date();
        const blockedUntil = tenant.blocked_until ? new Date(tenant.blocked_until) : null;
        
        if (blockedUntil && blockedUntil > now && tenant.manually_unblocked === 0) {
          return res.status(403).json({ 
            error: 'Account blocked',
            message: 'Your account has been blocked. Please contact the landlord.',
            blocked_until: tenant.blocked_until
          });
        }
      }
    }

    // Generate JWT token
    const token = jwt.sign(
      { user_id: user.user_id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        user_id: user.user_id,
        full_name: user.full_name,
        email: user.email,
        role: user.role,
        ...(user.role === 'tenant' && tenant ? { room_id: tenant.room_id } : {})
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
