"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emailService = void 0;
const logger_1 = require("@utils/logger");
const index_1 = require("@config/index");
class ConsoleEmailTransport {
    async send(message) {
        logger_1.logger.info(`📧 [DEV EMAIL] To: ${message.to} | Subject: ${message.subject}`);
        logger_1.logger.debug(`📧 [DEV EMAIL BODY]\n${message.text}`);
    }
}
const activeTransport = new ConsoleEmailTransport();
exports.emailService = {
    async sendPasswordResetEmail(to, resetToken) {
        const resetUrl = `${index_1.config.frontend.url}${index_1.config.frontend.passwordResetPath}?token=${resetToken}`;
        await activeTransport.send({
            to,
            subject: `Reset your ${index_1.config.app.name} password`,
            text: `We received a request to reset your password.\n\nReset it here (valid for ${index_1.config.auth.passwordResetExpiresIn}):\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email.`,
            html: `
        <p>We received a request to reset your ${index_1.config.app.name} password.</p>
        <p><a href="${resetUrl}">Click here to reset your password</a> (valid for ${index_1.config.auth.passwordResetExpiresIn}).</p>
        <p>If you didn't request this, you can safely ignore this email.</p>
      `,
        });
    },
};
//# sourceMappingURL=email.service.js.map