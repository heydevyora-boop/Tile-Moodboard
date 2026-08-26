import { logger } from '@utils/logger';
import { config } from '@config/index';

interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Dev/default transport — logs the email instead of sending it. This is
 * intentional: no SMTP/SendGrid/SES credentials exist yet. Swap
 * `activeTransport` below for a real implementation (e.g. nodemailer with
 * SMTP, or the SendGrid/Resend SDK) when those credentials are available —
 * nothing else in the app needs to change since callers only see
 * `emailService.sendPasswordResetEmail(...)`.
 */
class ConsoleEmailTransport implements EmailTransport {
  async send(message: EmailMessage): Promise<void> {
    logger.info(`📧 [DEV EMAIL] To: ${message.to} | Subject: ${message.subject}`);
    logger.debug(`📧 [DEV EMAIL BODY]\n${message.text}`);
  }
}

const activeTransport: EmailTransport = new ConsoleEmailTransport();

export const emailService = {
  async sendPasswordResetEmail(to: string, resetToken: string): Promise<void> {
    const resetUrl = `${config.frontend.url}${config.frontend.passwordResetPath}?token=${resetToken}`;

    await activeTransport.send({
      to,
      subject: `Reset your ${config.app.name} password`,
      text: `We received a request to reset your password.\n\nReset it here (valid for ${config.auth.passwordResetExpiresIn}):\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email.`,
      html: `
        <p>We received a request to reset your ${config.app.name} password.</p>
        <p><a href="${resetUrl}">Click here to reset your password</a> (valid for ${config.auth.passwordResetExpiresIn}).</p>
        <p>If you didn't request this, you can safely ignore this email.</p>
      `,
    });
  },
};
