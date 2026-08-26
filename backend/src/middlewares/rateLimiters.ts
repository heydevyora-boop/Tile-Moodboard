import rateLimit from 'express-rate-limit';

export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // 10 attempts per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, status: 'fail', message: 'Too many login attempts. Please try again in a few minutes.' },
  skipSuccessfulRequests: true,
});

export const forgotPasswordRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5, // 5 requests per hour per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, status: 'fail', message: 'Too many password reset requests. Please try again later.' },
});

/**
 * Every mood board generation is a real Gemini API call — billed per
 * request. The global rate limiter alone would let a single compromised
 * or careless account fire far more of these than any real staff workflow
 * needs, so this caps it more tightly per IP regardless of the global limit.
 */
export const moodBoardGenerationRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20, // 20 generations per 5 min per IP — generous for real usage, tight enough to blunt abuse/runaway cost
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, status: 'fail', message: 'Too many mood board generation requests. Please slow down.' },
});

/** Print board export (sync or async) does real image/PDF rendering — CPU and memory intensive, especially at high DPI. */
export const printBoardExportRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, status: 'fail', message: 'Too many export requests. Please slow down.' },
});
