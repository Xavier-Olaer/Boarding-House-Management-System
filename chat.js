const express = require('express');
const router = express.Router();
const db = require('./db');

// GET all messages between two users by user_id
router.get('/:userAId/:userBId', async (req, res) => {
  const { userAId, userBId } = req.params;

  try {
    const [messages] = await db.query(
      `SELECT m.message_id, m.sender_id, m.receiver_id, u.full_name AS sender_name, 
              m.message, m.sent_at
       FROM messages m
       JOIN users u ON m.sender_id = u.user_id
       WHERE (m.sender_id = ? AND m.receiver_id = ?)
          OR (m.sender_id = ? AND m.receiver_id = ?)
       ORDER BY m.sent_at ASC`,
      [userAId, userBId, userBId, userAId]
    );

    res.json({ messages });
  } catch (err) {
    console.error('Error fetching chat messages:', err);
    res.status(500).json({ error: 'Failed to fetch chat messages' });
  }
});

// POST a new message between two users by user_id
router.post('/:userAId/:userBId', async (req, res) => {
  const { userAId, userBId } = req.params;
  const { sender_id, message } = req.body;

  if (!message || !sender_id) {
    return res.status(400).json({ error: 'sender_id and message are required' });
  }

  // Determine the receiver_id based on sender_id
  let receiver_id;
  if (String(sender_id) === userAId) {
    receiver_id = userBId;
  } else if (String(sender_id) === userBId) {
    receiver_id = userAId;
  } else {
    return res.status(400).json({ error: 'sender_id does not match either userAId or userBId' });
  }

  try {
    await db.query(
      `INSERT INTO messages (sender_id, receiver_id, message, sent_at) 
       VALUES (?, ?, ?, NOW())`,
      [sender_id, receiver_id, message]
    );

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error sending message:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
