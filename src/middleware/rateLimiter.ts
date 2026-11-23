import rateLimit from "express-rate-limit";

/** Login: 5 attempts per 15 minutes per IP */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: "Too many login attempts, please try again later." },
});

/** Register: 10 attempts per hour per IP */
export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many registration attempts, please try again later." },
});
