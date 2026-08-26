// Augments Express's Request type. Populated by the authenticate
// middleware (src/middlewares/auth.ts) from a verified access token.
export {};

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: string;
        permissions: string[];
      };
    }
  }
}
