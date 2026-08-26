import { Router } from 'express';
import * as authController from '@controllers/auth.controller';
import { authenticate } from '@middlewares/auth';
import { validate } from '@middlewares/validate';
import { loginRateLimiter, forgotPasswordRateLimiter } from '@middlewares/rateLimiters';
import { loginSchema, forgotPasswordSchema, resetPasswordSchema } from '@validators/auth.validators';

const router = Router();

router.post('/login', loginRateLimiter, validate(loginSchema), authController.login);
router.post('/logout', authenticate, authController.logout);
router.post('/refresh', authController.refresh); // no `authenticate` — the access token is expired, that's the whole point
router.post('/forgot-password', forgotPasswordRateLimiter, validate(forgotPasswordSchema), authController.forgotPassword);
router.post('/reset-password', validate(resetPasswordSchema), authController.resetPassword);
router.get('/me', authenticate, authController.me);

export default router;
