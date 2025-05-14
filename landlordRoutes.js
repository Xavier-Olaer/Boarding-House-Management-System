const express = require('express');
const router = express.Router();
const db = require('./db'); 
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');
const sendEmail = require('./mailer');

// GET landlord dashboard overview
router.get('/overview', async (req, res) => {
  try {
    const [overviewData] = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM tenants) AS totalTenants,
        (SELECT COUNT(*) FROM rooms) AS totalRooms,
        (SELECT COALESCE(SUM(CAST(amount_due AS DECIMAL(10,2))), 0) 
         FROM rent_due 
         WHERE paid = 0) AS totalRentDue
    `);

    res.json({
      totalTenants: overviewData?.[0]?.totalTenants ?? 0,
      totalRooms: overviewData?.[0]?.totalRooms ?? 0,
      totalRentDue: parseFloat(overviewData?.[0]?.totalRentDue ?? 0)
    });
  } catch (err) {
    console.error('Error fetching overview:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT: Update tenant details
router.put('/tenants/update/:tenantId', async (req, res) => {
  const tenantId = req.params.tenantId;
  const { full_name, email, roomId, moveInDate, moveOutDate } = req.body;

  try {
    const [[tenant]] = await db.query(
      'SELECT room_id, user_id FROM tenants WHERE tenant_id = ?',
      [tenantId]
    );

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const currentRoomId = tenant.room_id;
    const userId = tenant.user_id;

    // Update user details if changed
    await db.query('UPDATE users SET full_name = ?, email = ? WHERE user_id = ?', [full_name, email, userId]);

    const moveOut = moveOutDate === '' ? null : moveOutDate;

    // Update tenant room & dates
    await db.query(
      'UPDATE tenants SET room_id = ?, move_in_date = ?, move_out_date = ? WHERE tenant_id = ?',
      [roomId, moveInDate, moveOut, tenantId]
    );

    // Handle room status change if different
    if (roomId !== currentRoomId) {
      await db.query('UPDATE rooms SET status = 0 WHERE room_id = ?', [currentRoomId]);
      await db.query('UPDATE rooms SET status = 1 WHERE room_id = ?', [roomId]);

      const activity = `Moved from room ID ${currentRoomId} to room ID ${roomId}`;
      await db.query(
        'INSERT INTO activity_logs (user_id, activity, entity_type, entity_id) VALUES (?, ?, "tenant", ?)',
        [userId, activity, tenantId]
      );

      const [[newRoom]] = await db.query('SELECT price FROM rooms WHERE room_id = ?', [roomId]);
      if (newRoom) {
        await db.query(
          'UPDATE rent_due SET amount_due = ? WHERE tenant_id = ? AND paid = 0',
          [newRoom.price, tenantId]
        );
      }
    }

    res.json({ message: 'Tenant details updated successfully' });
  } catch (err) {
    console.error('Error updating tenant:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});






// GET: Fetch tenant details by tenantId
router.get('/tenants/:tenantId', async (req, res) => {
  const tenantId = req.params.tenantId;

  try {
    const [rows] = await db.query(`
      SELECT 
        t.tenant_id,
        u.full_name AS tenant_name,
        u.email,
        r.room_label,
        t.move_in_date,
        t.move_out_date
      FROM tenants t
      JOIN users u ON t.user_id = u.user_id
      LEFT JOIN rooms r ON t.room_id = r.room_id
      WHERE t.tenant_id = ?
    `, [tenantId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    res.json(rows[0]); // Return the first (and only) tenant record
  } catch (err) {
    console.error('Error fetching tenant details:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET list of tenants 
router.get('/tenants', async (req, res) => {
    try {
      const [rows] = await db.query(`
        SELECT 
          t.tenant_id,
          t.user_id,
          t.room_id,
          t.move_in_date,
          t.move_out_date,
          t.blocked_until,
          t.manually_unblocked,
          u.full_name,
          u.email,
          u.contact_number,
          r.room_label,
          r.room_type,
          r.price,
          CASE 
            WHEN t.blocked_until IS NOT NULL 
             AND t.blocked_until > CURRENT_DATE() 
             AND t.manually_unblocked = 0 
            THEN 1
            ELSE 0
          END as is_blocked
        FROM tenants t
        LEFT JOIN users u ON t.user_id = u.user_id
        LEFT JOIN rooms r ON t.room_id = r.room_id
        ORDER BY t.tenant_id ASC
      `);
  
      res.json({ tenants: rows });
    } catch (error) {
      console.error('Error fetching tenants:', error);
      res.status(500).json({ error: 'Failed to fetch tenants' });
    }
});

  router.put('/tenants/:id', async (req, res) => {
    const tenantId = req.params.id;
    const { full_name, email, room_id } = req.body;
  
    try {
      // First, get the current user details
      const [currentUser] = await db.query(
        `SELECT full_name, email FROM users WHERE user_id = (SELECT user_id FROM tenants WHERE tenant_id = ?);`,
        [tenantId]
      );
  
      // Initialize an array to hold queries
      let queries = [];
  
      
      if (currentUser[0].full_name !== full_name) {
        queries.push(
          db.query(
            `UPDATE users
             SET full_name = ?
             WHERE user_id = (SELECT user_id FROM tenants WHERE tenant_id = ?);`,
            [full_name, tenantId]
          )
        );
      }
  
      // If the email is different, prepare an update for it
      if (currentUser[0].email !== email) {
        queries.push(
          db.query(
            `UPDATE users
             SET email = ?
             WHERE user_id = (SELECT user_id FROM tenants WHERE tenant_id = ?);`,
            [email, tenantId]
          )
        );
      }
  
      // Update the room_id for the tenant
      queries.push(
        db.query(
          `UPDATE tenants
           SET room_id = ?
           WHERE tenant_id = ?`,
          [room_id, tenantId]
        )
      );
  
      // Execute all queries
      await Promise.all(queries);
  
      res.status(200).json({ message: 'Tenant updated successfully' });
    } catch (err) {
      console.error('Error updating tenant:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  
router.get('/rooms', async (req, res) => {
  try {
    const [rooms] = await db.query(`
      SELECT 
        r.room_id,
        r.room_label,
        r.room_type,
        r.capacity,
        r.price,
        COUNT(t.tenant_id) AS occupancy,
        CONCAT(COUNT(t.tenant_id), ' / ', r.capacity) AS occupancy_display,
        CASE 
          WHEN COUNT(t.tenant_id) = 0 THEN 0
          WHEN COUNT(t.tenant_id) < r.capacity THEN 2
          ELSE 1
        END AS status
      FROM rooms r
      LEFT JOIN tenants t ON r.room_id = t.room_id
      GROUP BY r.room_id, r.room_label, r.room_type, r.capacity, r.price
    `);

    res.json(rooms);
  } catch (err) {
    console.error('Error fetching rooms:', err);
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

// POST: Add a new room
router.post('/rooms', async (req, res) => {
  const { room_label, room_type, capacity, price, status } = req.body;

  // Validate the incoming data
  if (!room_label || !room_type || capacity == null || price == null || status == null) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
    const [result] = await db.query(`
      INSERT INTO rooms (room_label, room_type, capacity, price, status) 
      VALUES (?, ?, ?, ?, ?)`,
      [room_label, room_type, capacity, price, status]);

    res.status(201).json({ message: 'Room added successfully!' });
  } catch (err) {
    console.error('Error adding room:', err);
    res.status(500).json({ error: 'Failed to add room' });
  }
});




// GET list of rent dues
router.get('/rent-due', async (req, res) => {
    try {
      const [rows] = await db.query(`
        SELECT 
          rd.rent_due_id,
          u.full_name AS tenant_name,
          rd.amount_due,
          rd.due_date,
          rd.paid
        FROM rent_due rd
        JOIN tenants t ON rd.tenant_id = t.tenant_id
        JOIN users u ON t.user_id = u.user_id
        ORDER BY rd.due_date DESC
      `);
      res.json({ rentDue: rows });
    } catch (err) {
      console.error('Error fetching rent due:', err);
      res.status(500).json({ error: 'Failed to retrieve rent due data' });
    }
  });

  // PUT: Mark rent as paid
router.put('/rent-due/:tenantId/pay', async (req, res) => {
  const tenantId = req.params.tenantId;

  try {
    const [result] = await db.query(`
      UPDATE rent_due
      SET paid = 1
      WHERE tenant_id = ? AND paid = 0
    `, [tenantId]);

    if (result.affectedRows > 0) {
      res.json({ message: 'Rent marked as paid successfully!' });
    } else {
      res.status(400).json({ error: 'Failed to mark rent as paid. Maybe the rent is already paid.' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error marking rent as paid.' });
  }
});

  // GET all maintenance requests
router.get('/maintenance-requests', async (req, res) => {
    try {
      const [rows] = await db.query(`
        SELECT 
          mr.request_id,
          u.full_name AS tenant_name,
          r.room_label,
          mr.description,
          mr.status,
          mr.reason,
          mr.created_at,
          mr.updated_at
        FROM maintenance_requests mr
        JOIN tenants t ON mr.tenant_id = t.tenant_id
        JOIN users u ON t.user_id = u.user_id
        JOIN rooms r ON mr.room_id = r.room_id
        ORDER BY mr.created_at DESC
      `);
      res.json({ requests: rows });
    } catch (err) {
      console.error('Error fetching maintenance requests:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PATCH: Update maintenance request status
router.patch('/maintenance-requests/:id/status', async (req, res) => {
  const requestId = req.params.id;
  const { id } = req.params;
  const { status, reason } = req.body;

  const validStatuses = ['pending', 'in_progress', 'completed', 'rejected'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status value.' });
  }

  try {
    const [result] = await db.query(
      `UPDATE maintenance_requests SET status = ?, reason = ?, updated_at = NOW() WHERE request_id = ?`,
      [status, reason || null, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Maintenance request not found.' });
    }
    const userId = 1;
    // Log the activity with user_id and maintenance request info
    await db.query(
      'INSERT INTO activity_logs (user_id, activity, entity_type, entity_id) VALUES (?, ?, ?, ?)',
      [
        userId,
        `Updated maintenance request status to "${status}"${reason ? ` with reason: ${reason}` : ''}`,
        'maintenance_request',
        requestId
      ]
    );

    res.json({ message: 'Status updated successfully.' });
  } catch (err) {
    console.error('Error updating maintenance request status:', err);
    res.status(500).json({ error: 'Failed to update status.' });
  }
});


  // GET activity logs
  router.get('/activity-logs', async (req, res) => {
    try {
      const [rows] = await db.query(`
        SELECT 
          al.log_id,
          u.full_name AS user_name,
          al.activity,
          al.entity_type,
          al.entity_id,
          al.created_at
        FROM activity_logs al
        JOIN users u ON al.user_id = u.user_id
        ORDER BY al.created_at DESC
      `);
  
      res.json({ logs: rows });
    } catch (err) {
      console.error('Error fetching activity logs:', err);
      res.status(500).json({ error: 'Failed to fetch activity logs' });
    }
  });

// GET blocked tenants
router.get('/blocked-tenants', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT 
        t.tenant_id,
        t.user_id,
        t.blocked_until,
        u.full_name,
        u.email,
        r.room_label,
        rd.amount_due,
        rd.due_date
      FROM tenants t
      JOIN users u ON t.user_id = u.user_id
      JOIN rooms r ON t.room_id = r.room_id
      LEFT JOIN rent_due rd ON rd.tenant_id = t.tenant_id AND rd.paid = 0
      WHERE t.blocked_until > CURDATE()
      ORDER BY t.blocked_until DESC
    `);

    res.json({ blockedTenants: rows });
  } catch (err) {
    console.error('Error fetching blocked tenants:', err);
    res.status(500).json({ error: 'Failed to fetch blocked tenants' });
  }
});

// Unblock tenant endpoint
router.post('/unblock-tenant/:tenant_id', async (req, res) => {
  const { tenant_id } = req.params;

  try {
    // Update both manually_unblocked status and blocked_until in the tenants table
    await db.query(
      'UPDATE tenants SET manually_unblocked = 1, blocked_until = NULL WHERE tenant_id = ?',
      [tenant_id]
    );

    // Get the tenant information for activity log
    const [[tenant]] = await db.query(`
      SELECT 
        t.tenant_id,
        t.user_id,
        u.full_name
      FROM tenants t
      JOIN users u ON t.user_id = u.user_id
      WHERE t.tenant_id = ?
    `, [tenant_id]);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Log the activity
    await db.query(
      'INSERT INTO activity_logs (user_id, activity, entity_type, entity_id) VALUES (?, ?, "tenant", ?)',
      [1, `Unblocked tenant ${tenant.full_name}`, tenant_id]
    );

    res.json({ message: 'Tenant successfully unblocked' });

  } catch (error) {
    console.error('Error unblocking tenant:', error);
    res.status(500).json({ error: 'Failed to unblock tenant' });
  }
});

module.exports = router;

