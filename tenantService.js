const db = require('./db');

// Function to fetch tenants with upcoming rent due dates
async function getTenantsWithUpcomingDueDate() {
  const query = `
  SELECT 
    rd.due_date AS rent_due_date,
    u.full_name AS tenant_name,
    u.email AS tenant_email,
    (SELECT email FROM users WHERE user_id = 1) AS landlord_email
  FROM rent_due rd
  JOIN tenants t ON rd.tenant_id = t.tenant_id
  JOIN users u ON t.user_id = u.user_id
  WHERE rd.due_date <= CURDATE() + INTERVAL 7 DAY
    AND rd.paid = 0
`;
  try {
    const [rows] = await db.query(query);
    return rows;
  } catch (err) {
    console.error('Error fetching tenants with rent due:', err);
    throw err;
  }
}

async function getLandlordEmail() {
  const query = `SELECT email FROM users WHERE user_id = 1`; // static ID
  try {
    const [rows] = await db.query(query);
    return rows[0]?.email || null;
  } catch (err) {
    console.error('Error fetching landlord email:', err);
    throw err;
  }
}

module.exports = { getTenantsWithUpcomingDueDate, getLandlordEmail };