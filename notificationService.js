const db = require('./db');

// Save a notification in the DB
async function createNotification(userId, message) {
  const query = `
    INSERT INTO notifications (user_id, message)
    VALUES (?, ?)
  `;

  try {
    await db.query(query, [userId, message]);
    console.log(`Notification saved for user ${userId}`);
  } catch (error) {
    console.error('Failed to create notification:', error);
  }
}

module.exports = { createNotification };
