import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: 'smtp.zoho.eu',
  port: 465,
  secure: true,
  auth: {
    user: 'no-reply@dayfi.co',
    pass: '9azNFSNvBwU2',
  },
});

export async function sendVerificationEmail(
  userEmail: string,
  subject: string,
  text: string,
  html: string
) {
  try {
    const mailOptions = {
      from: '"Dayfi" <no-reply@dayfi.co>',
      to: userEmail,
      subject: subject,
      text: text,
      html: html,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent: ' + info.messageId);
  } catch (error) {
    console.error('Error sending email:', error);
  }
}
