const express = require('express');
const router = express.Router();
const db = require('./db');

// Get boarding info 
router.get('/boarding-info/:user_id', async (req, res) => {
  const { user_id } = req.params;

  try {
    const sql = `
      SELECT u.full_name, t.tenant_id, r.room_id, r.room_label, r.price, t.move_in_date, rd.amount_due, rd.paid_amount, rd.due_date
      FROM tenants t
      JOIN users u ON t.user_id = u.user_id
      JOIN rooms r ON t.room_id = r.room_id
      LEFT JOIN rent_due rd ON rd.tenant_id = t.tenant_id AND rd.paid < rd.amount_due
      WHERE t.user_id = ?
      ORDER BY rd.due_date ASC
      LIMIT 1;`;

    const [rows] = await db.execute(sql, [user_id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No boarding info found' });
    }

    res.json({ boardingInfo: rows[0] });
  } catch (error) {
    console.error('Error fetching boarding info:', error);
    res.status(500).json({ error: 'Failed to fetch boarding info' });
  }
});

// Get payment history 
router.get('/payment-history/:user_id', async (req, res) => {
  const { user_id } = req.params;

  try {
    // Get tenant_id from user_id
    const [tenantRes] = await db.query(
      'SELECT tenant_id FROM tenants WHERE user_id = ?',
      [user_id]
    );
    if (tenantRes.length === 0)
      return res.status(404).json({ message: 'Tenant not found' });

    const tenantId = tenantRes[0].tenant_id;

    // 1. Payment History
    const [payments] = await db.query(`
      SELECT 
        p.amount, p.method, p.paid_at,
        rd.amount_due, rd.due_date,
        r.room_label,
        CASE
          WHEN rd.amount_due > rd.paid_amount THEN 'Unpaid'
          ELSE 'Paid'
        END AS status
      FROM payments p
      JOIN rent_due rd ON p.rent_due_id = rd.rent_due_id
      JOIN tenants t ON p.tenant_id = t.tenant_id
      LEFT JOIN rooms r ON t.room_id = r.room_id
      WHERE p.tenant_id = ?
      ORDER BY p.paid_at DESC
    `, [tenantId]);
    

    // 2. Get all unpaid rent dues and total them
    const [unpaidResults] = await db.query(`
      SELECT 
        SUM(amount_due - IFNULL(paid_amount, 0)) as total_unpaid,
        MIN(due_date) as earliest_due_date,
        GROUP_CONCAT(amount_due) as individual_amounts,
        GROUP_CONCAT(IFNULL(paid_amount, 0)) as individual_paid_amounts,
        GROUP_CONCAT(due_date) as due_dates
      FROM rent_due
      WHERE tenant_id = ? AND paid = 0
    `, [tenantId]);

    // 3. Credit balance
    const [credits] = await db.query(`
      SELECT SUM(amount) AS total_credits
      FROM credits
      WHERE tenant_id = ?
    `, [tenantId]);

    let unpaid = null;
    let creditBalance = parseFloat(credits[0].total_credits) || 0;

    // Process unpaid rent information
    if (unpaidResults[0].total_unpaid) {
      const totalUnpaid = parseFloat(unpaidResults[0].total_unpaid);
      const earliestDueDate = unpaidResults[0].earliest_due_date;
      
      // Get individual amounts for detailed display
      const amounts = unpaidResults[0].individual_amounts ? unpaidResults[0].individual_amounts.split(',').map(Number) : [];
      const paidAmounts = unpaidResults[0].individual_paid_amounts ? unpaidResults[0].individual_paid_amounts.split(',').map(Number) : [];
      const dueDates = unpaidResults[0].due_dates ? unpaidResults[0].due_dates.split(',') : [];

      let simulatedPaid = creditBalance; // Use credit balance if available

      unpaid = {
        amount_due: totalUnpaid.toFixed(2),
        paid_amount: simulatedPaid.toFixed(2),
        due_date: earliestDueDate,
        details: amounts.map((amount, i) => ({
          amount_due: amount,
          paid_amount: paidAmounts[i] || 0,
          due_date: dueDates[i]
        }))
      };

      // Adjust credit balance after simulation
      creditBalance = Math.max(0, creditBalance - totalUnpaid);
    }

    res.json({
      paymentHistory: payments,
      unpaid,
      creditBalance
    });

  } catch (error) {
    console.error('Error fetching payment history:', error);
    res.status(500).json({ error: 'Failed to fetch payment history' });
  }
});

router.post('/payment/:user_id', async (req, res) => {
  const { user_id } = req.params;
  const { amount, method } = req.body;

  try {
    const paymentAmount = parseFloat(amount);
    const [tenantResult] = await db.query('SELECT tenant_id FROM tenants WHERE user_id = ?', [user_id]);
    if (tenantResult.length === 0)
      return res.status(404).json({ message: 'Tenant not found' });

    const tenantId = tenantResult[0].tenant_id;
    let remaining = paymentAmount;

    // Fetch credit
    const [[{ total_credit }]] = await db.query(`
      SELECT IFNULL(SUM(amount), 0) AS total_credit FROM credits WHERE tenant_id = ?
    `, [tenantId]);
    let creditAmount = parseFloat(total_credit || 0);

    // Get earliest unpaid rent
    const [rentDueResult] = await db.query(`
      SELECT * FROM rent_due WHERE tenant_id = ? AND paid = 0 ORDER BY due_date ASC LIMIT 1
    `, [tenantId]);

    if (rentDueResult.length === 0) {
      if (paymentAmount > 0) {
        // No unpaid rent — treat entire payment as credit
        await db.query(`INSERT INTO credits (tenant_id, amount) VALUES (?, ?)`, [tenantId, paymentAmount]);
      }
      return res.json({ message: 'No rent due. Payment stored as credit.' });
    }

    const rentDue = rentDueResult[0];
    const rentDueId = rentDue.rent_due_id;
    const amountDue = parseFloat(rentDue.amount_due);
    let paidAmount = parseFloat(rentDue.paid_amount || 0);
    let totalRemainingDue = amountDue - paidAmount;

    let creditUsed = 0;
    let manualUsed = 0;

    // Apply credit if not already applied
    const [[{ creditPaidAlready }]] = await db.query(`
      SELECT COUNT(*) AS creditPaidAlready
      FROM payments
      WHERE tenant_id = ? AND rent_due_id = ? AND method = 'Credit'
    `, [tenantId, rentDueId]);

    if (creditAmount > 0 && totalRemainingDue > 0 && creditPaidAlready === 0) {
      creditUsed = Math.min(creditAmount, totalRemainingDue);
      paidAmount += creditUsed;
      totalRemainingDue -= creditUsed;

      await db.query(`
        INSERT INTO payments (tenant_id, rent_due_id, amount, method, paid_at, status)
        VALUES (?, ?, ?, 'Credit', NOW(), 'paid')
      `, [tenantId, rentDueId, creditUsed]);

      await db.query(`DELETE FROM credits WHERE tenant_id = ?`, [tenantId]);

      const leftoverCredit = creditAmount - creditUsed;
      if (leftoverCredit > 0) {
        await db.query(`INSERT INTO credits (tenant_id, amount) VALUES (?, ?)`, [tenantId, leftoverCredit]);
      }
    }

    // Apply manual payment
    if (remaining > 0 && totalRemainingDue > 0) {
      manualUsed = Math.min(remaining, totalRemainingDue);
      paidAmount += manualUsed;
      totalRemainingDue -= manualUsed;

      await db.query(`
        INSERT INTO payments (tenant_id, rent_due_id, amount, method, paid_at, status)
        VALUES (?, ?, ?, ?, NOW(), 'paid')
      `, [tenantId, rentDueId, manualUsed, method]);
    }

    // Final rent_due update
    const isFullyPaid = paidAmount >= amountDue;
    await db.query(`
      UPDATE rent_due
      SET paid_amount = ?, paid = ?
      WHERE rent_due_id = ?
    `, [paidAmount, isFullyPaid ? 1 : 0, rentDueId]);

    // If fully paid using only credit, and no manual payment
    if (isFullyPaid && manualUsed === 0 && creditUsed > 0 && !method) {
      return res.json({ message: 'Rent fully paid with credit. No manual payment needed.' });
    }

    // Handle overpayment
    const overpay = remaining - manualUsed;
    if (overpay > 0) {
      await db.query(`INSERT INTO credits (tenant_id, amount) VALUES (?, ?)`, [tenantId, overpay]);
    }

    res.json({ message: 'Payment processed successfully.' });

  } catch (error) {
    console.error('Payment processing error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});



router.get('/maintenance-requests/:user_id', async (req, res) => {
  const { user_id } = req.params;

  console.log("Received user_id: ", user_id);  // Log the incoming user_id

  try {
    // Get tenant_id and room_id from user_id
    const [tenantRows] = await db.execute(
      'SELECT tenant_id, room_id FROM tenants WHERE user_id = ?',
      [user_id]
    );

    if (tenantRows.length === 0) {
      console.log("No tenant found for user_id: ", user_id);  // Log if no tenant found
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const tenant_id = tenantRows[0].tenant_id;
    const room_id = tenantRows[0].room_id;

    console.log("Tenant ID: ", tenant_id);  // Log tenant_id
    console.log("Room ID from tenant: ", room_id);  // Log room_id fetched from database

    // Fetch maintenance requests and room labels
    const [requests] = await db.execute(
      `SELECT mr.description, mr.status, mr.created_at, mr.reason, r.room_label
       FROM maintenance_requests mr
       JOIN rooms r ON mr.room_id = r.room_id
       WHERE mr.tenant_id = ?
       ORDER BY mr.created_at DESC`,
      [tenant_id]
    );

    res.json({ maintenanceRequests: requests });
  } catch (error) {
    console.error('Error fetching maintenance requests:', error);
    res.status(500).json({ error: 'Failed to fetch maintenance requests' });
  }
});




// POST maintenance request
router.post('/maintenance-request', async (req, res) => {
  const { tenant_id, room_id, description } = req.body;

  console.log("Incoming request data: ", req.body);  // Log incoming data
  
  try {
    if (!tenant_id || !room_id || !description) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if the tenant exists by tenant_id (from user_id)
    const [userRows] = await db.execute('SELECT tenant_id FROM tenants WHERE user_id = ?', [tenant_id]);
    console.log("User rows found:", userRows);  // Debug log for userRows

    if (userRows.length === 0) {
      console.log('Tenant not found for user_id:', tenant_id);  // Log if no tenant is found for the user_id
      return res.status(400).json({ error: 'Tenant not found' });
    }

    const tenant_id_from_user = userRows[0].tenant_id;  // Get the tenant_id from user_id
    console.log("Tenant ID from user_id:", tenant_id_from_user);  // Log the tenant_id derived from user_id

    // Check if the room_id exists in the rooms table
    const [roomRows] = await db.execute('SELECT room_id FROM rooms WHERE room_id = ?', [room_id]);
    console.log("Room rows found:", roomRows);  // Debug log for roomRows

    if (roomRows.length === 0) {
      console.log('Room not found:', room_id);
      return res.status(400).json({ error: 'Room not found' });
    }

    // Insert the maintenance request into the database
    const sql = `
      INSERT INTO maintenance_requests (tenant_id, room_id, description, status, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', NOW(), NOW());
    `;
    const [result] = await db.execute(sql, [tenant_id_from_user, room_id, description]);

    console.log("Inserted maintenance request with ID: ", result.insertId); // Log insert ID

    res.status(201).json({ message: 'Maintenance request submitted successfully' });
  } catch (error) {
    console.error('Error submitting maintenance request:', error);
    console.error('Full error:', error);
    res.status(500).json({ error: 'Failed to submit maintenance request' });
  }
});





/*


// GET chat messages for tenant and landlord
router.get('/chat/:tenantId/:landlordId', async (req, res) => {
  const { tenantId, landlordId } = req.params;

  try {
    const [messages] = await db.query(
      `SELECT m.sender_id, m.receiver_id, u.full_name AS sender_name, m.message, m.sent_at
       FROM messages m
       JOIN users u ON m.sender_id = u.user_id
       WHERE (sender_id = ? AND receiver_id = ?)
          OR (sender_id = ? AND receiver_id = ?)
       ORDER BY m.sent_at ASC`,
      [tenantId, landlordId, landlordId, tenantId]
    );

    res.json({ messages });
  } catch (err) {
    console.error('Error fetching chat messages:', err);
    res.status(500).json({ error: 'Failed to fetch chat messages' });
  }
});

// POST message from tenant to landlord
router.post('/chat/:tenantId/:landlordId', async (req, res) => {
  const { tenantId, landlordId } = req.params;
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message content is required' });
  }

  try {
    await db.query(
      `INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)`,
      [tenantId, landlordId, message]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error sending message:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});


*/


module.exports = router;
