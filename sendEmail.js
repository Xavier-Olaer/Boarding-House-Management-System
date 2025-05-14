const nodemailer = require("nodemailer");
const { google } = require("googleapis");

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const SENDER_EMAIL = process.env.SENDER_EMAIL;

const oAuth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

async function sendMail(tenantName, tenantEmail, landlordEmail) {
  try {
    const accessToken = await oAuth2Client.getAccessToken();

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type: 'OAuth2',
        user: SENDER_EMAIL,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: REFRESH_TOKEN,
        accessToken: accessToken.token,
      },
    });

    const tenantMailOptions = {
      from: `Boarding House <${SENDER_EMAIL}>`,
      to: tenantEmail,
      subject: 'Rent Due Reminder',
      text: `Dear ${tenantName},\n\nThis is a reminder that your rent is due soon. Please make your payment on time to avoid penalties.\n\nThank you.`,
    };

    const landlordMailOptions = {
      from: `Boarding House <${SENDER_EMAIL}>`,
      to: landlordEmail,
      subject: 'Tenant Rent Reminder Sent',
      text: `The tenant ${tenantName} (${tenantEmail}) has been reminded about their upcoming rent due.`,
    };

    const tenantResult = await transporter.sendMail(tenantMailOptions);
    const landlordResult = await transporter.sendMail(landlordMailOptions);

    console.log('Tenant email sent:', tenantResult.response);
    console.log('Landlord email sent:', landlordResult.response);

  } catch (error) {
    console.error('Error sending email:', error);
  }
}

module.exports = sendMail;