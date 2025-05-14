const cron = require('node-cron');
const mysql = require('mysql2/promise');
const sendMail = require('./sendEmail');
const { createNotification } = require('./notificationService');

const landlordEmail = process.env.LANDLORD_EMAIL || 'yourlandlord@email.com';

function initializeCronJobs() {
  console.log('Initializing cron jobs...');

  // Schedule to run every day at 8:00 AM
  const reminderJob = cron.schedule('0 8 * * *', async () => {
    try {
      // Connect to your database
      const db = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
      });

      // Query tenants with rent due in the next 7 days (adjust as needed)
      const [rows] = await db.execute(`
        SELECT u.full_name, u.email, t.tenant_id, r.due_date
        FROM tenants t
        JOIN users u ON t.user_id = u.user_id
        JOIN rent_due r ON t.tenant_id = r.tenant_id
        WHERE r.due_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)
          AND r.paid = 0
      `);

      for (const tenant of rows) {
        await sendMail(tenant.full_name, tenant.email, landlordEmail);
      }

      await db.end();
      console.log(`[${new Date().toISOString()}] Rent due reminders sent.`);
    } catch (err) {
      console.error('Error in rent due reminder cron job:', err);
      
      // Notify admin/landlord of any errors
      await createNotification(1, 'Error in rent reminder system. Please check logs.');
    }
  });

  // Start the job
  reminderJob.start();
  console.log('Cron jobs initialized successfully.');

  // Return the job instance in case we need to stop it later
  return reminderJob;
}

// Schedule to run at midnight on the 1st of every month
const monthlyRentJob = cron.schedule('0 0 1 * *', async () => {
  try {
    const db = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    });

    // Get all active tenants
    const [tenants] = await db.execute(`
      SELECT t.tenant_id, t.room_id, r.price
      FROM tenants t
      JOIN rooms r ON t.room_id = r.room_id
      WHERE t.move_out_date IS NULL OR t.move_out_date > CURDATE()
    `);

    // Calculate the first day of the next month
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const monthYearStr = nextMonth.toISOString().split('T')[0]; // YYYY-MM-DD

    for (const tenant of tenants) {
      // Check if a rent_due record already exists for this tenant and month
      const [existing] = await db.execute(
        `SELECT rent_due_id FROM rent_due WHERE tenant_id = ? AND month_year = ?`,
        [tenant.tenant_id, monthYearStr]
      );

      if (existing.length === 0) {
        // Insert new rent due record
        await db.execute(
          `INSERT INTO rent_due (tenant_id, amount_due, due_date, paid, paid_amount, month_year) VALUES (?, ?, ?, 0, 0.00, ?)`,
          [tenant.tenant_id, tenant.price, monthYearStr, monthYearStr]
        );
      }
    }

    await db.end();
    console.log(`[${new Date().toISOString()}] Monthly rent due records created.`);
  } catch (err) {
    console.error('Error in monthly rent due cron job:', err);
  }
});

monthlyRentJob.start();

module.exports = { initializeCronJobs };
