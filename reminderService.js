const sendEmail = require('./mailer'); // Import the sendEmail function from mailer.js
const { getLandlordEmail } = require('./tenantService');

// Notify Tenant of reminder email
async function sendRentDueReminder(tenantEmail, tenantName, dueDate) {
  const subject = 'Rent Due Reminder';
  const text = `Hello ${tenantName},\n\nYour rent is due on ${dueDate}. Please make sure to make the payment on time.\n\nBest regards,\nYour Boarding House Team`;

  try {
    await sendEmail(tenantEmail, subject, text); // Call the sendEmail function from mailer.js
    console.log(`Rent due reminder sent to ${tenantEmail}`);
  } catch (error) {
    console.error(`Failed to send rent due reminder to ${tenantEmail}:`, error);
  }
}

// Notify landlord of reminder sent
async function notifyLandlordOfReminder(landlordEmail, tenantName, dueDate) {
  const subject = 'Tenant Rent Reminder Sent';
  const text = `Reminder email sent to ${tenantName} for rent due on ${dueDate}.`;

  try {
    await sendEmail(landlordEmail, subject, text);
    console.log(`Landlord notified for ${tenantName}`);
  } catch (error) {
    console.error(`Failed to notify landlord:`, error);
  }
}

async function notifyLandlordByEmail(tenantName, tenantEmail, dueDate) {
  try {
    const landlordEmail = await getLandlordEmail();
    if (!landlordEmail) {
      console.error('Landlord email not found');
      return;
    }

    const subject = 'Tenant Rent Reminder Sent';
    const text = `Reminder email sent to ${tenantName} (${tenantEmail}) for rent due on ${dueDate}.`;

    await sendEmail(landlordEmail, subject, text);
    console.log(`Landlord notified via email at ${landlordEmail}`);
  } catch (error) {
    console.error(`Failed to notify landlord via email:`, error);
  }
}

module.exports = { sendRentDueReminder, notifyLandlordOfReminder, notifyLandlordByEmail };
