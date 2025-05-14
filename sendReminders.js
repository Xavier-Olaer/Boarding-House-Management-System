const nodemailer = require("nodemailer");
const { google } = require("googleapis");
const dayjs = require("dayjs");
const db = require("./db");

// OAuth2 setup
const CLIENT_ID = 'REMOVED';
const CLIENT_SECRET = 'REMOVED';
const REDIRECT_URI = 'REMOVED';
const REFRESH_TOKEN = '1//0emdxSJ0pNzyKCgYIARAAGA4SNwF-L9IrN-nAGujUm7d4kGPW-b5LYterMBuJT2dWJO3eFFBKvbSq-yIYNu_efP8siaPdAWqGtyE';
const SENDER_EMAIL = 'REMOVED';

const oAuth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

async function sendReminderEmails() {
  try {
    // Get landlord email
    const [[landlord]] = await db.query(
      "SELECT email FROM users WHERE user_id = 1"
    );

    if (!landlord) {
      console.error("Landlord not found.");
      return;
    }

    // Get all unpaid rent records with tenant and room information
    const [tenants] = await db.query(`
      SELECT 
        t.tenant_id,
        t.user_id AS tenant_user_id,
        u.full_name AS tenant_name,
        u.email AS tenant_email,
        r.room_label,
        r.price AS room_price,
        rd.amount_due,
        rd.due_date,
        rd.paid,
        rd.rent_due_id
      FROM tenants t
      JOIN users u ON t.user_id = u.user_id
      JOIN rooms r ON t.room_id = r.room_id
      JOIN rent_due rd ON rd.tenant_id = t.tenant_id
      WHERE rd.paid = 0
    `);

    const accessToken = await oAuth2Client.getAccessToken();
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        type: "OAuth2",
        user: SENDER_EMAIL,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: REFRESH_TOKEN,
        accessToken: accessToken.token,
      },
    });

    const today = dayjs();

    for (const tenant of tenants) {
      const dueDate = dayjs(tenant.due_date);
      const daysUntilDue = dueDate.diff(today, 'day');

      // Send reminder 3 days before due date
      if (daysUntilDue === 3) {
        // Send reminder to tenant
        await transporter.sendMail({
          from: `Boarding House Management <${SENDER_EMAIL}>`,
          to: tenant.tenant_email,
          subject: "Rent Due Reminder",
          text: `Dear ${tenant.tenant_name},\n\nThis is a reminder that your rent of ₱${tenant.amount_due} for Room ${tenant.room_label} is due in 3 days.\n\nPlease ensure to make the payment on time to avoid any inconvenience.\n\nBest regards,\nBoarding House Management`
        });

        // Notify landlord
        await transporter.sendMail({
          from: `Boarding House Management <${SENDER_EMAIL}>`,
          to: landlord.email,
          subject: "Rent Reminder Sent",
          text: `A rent reminder has been sent to ${tenant.tenant_name} (Room ${tenant.room_label}).\nDue Amount: ₱${tenant.amount_due}\nDue Date: ${dueDate.format('MMMM D, YYYY')}`
        });

        console.log(`Reminder sent to ${tenant.tenant_email} and landlord notified.`);
      }

      // Handle overdue accounts (1 day after due date)
      if (daysUntilDue === -1) {
        // Block tenant account
        const blockedUntil = today.add(9999, 'days').format('YYYY-MM-DD');
        await db.query(`
          UPDATE tenants
          SET blocked_until = ?
          WHERE tenant_id = ?
        `, [blockedUntil, tenant.tenant_id]);

        // Notify tenant of account block
        await transporter.sendMail({
          from: `Boarding House Management <${SENDER_EMAIL}>`,
          to: tenant.tenant_email,
          subject: "Account Blocked - Overdue Rent",
          text: `Dear ${tenant.tenant_name},\n\nYour account has been blocked due to overdue rent payment for Room ${tenant.room_label}.\nPlease contact the landlord to resolve this issue.\n\nAmount Due: ₱${tenant.amount_due}\n\nBest regards,\nBoarding House Management`
        });

        // Notify landlord of tenant block
        await transporter.sendMail({
          from: `Boarding House Management <${SENDER_EMAIL}>`,
          to: landlord.email,
          subject: "Tenant Account Blocked - Overdue Rent",
          text: `Tenant ${tenant.tenant_name} (Room ${tenant.room_label}) has been blocked due to overdue rent.\nAmount Due: ₱${tenant.amount_due}`
        });

        console.log(`Tenant ${tenant.tenant_email} has been blocked for non-payment.`);

        // Log the block in activity_logs
        await db.query(`
          INSERT INTO activity_logs (user_id, activity, entity_type, entity_id)
          VALUES (?, ?, 'tenant', ?)
        `, [tenant.tenant_user_id, 'Account blocked due to overdue rent', tenant.tenant_id]);
      }
    }

  } catch (error) {
    console.error("Error in reminder system:", error);
  }
}

// Export for use in cron job
module.exports = { sendReminderEmails };

// If running directly, execute immediately
if (require.main === module) {
  sendReminderEmails()
    .then(() => console.log('Reminder process completed'))
    .catch(console.error);
} 