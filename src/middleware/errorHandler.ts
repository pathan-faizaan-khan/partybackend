import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  // Zod validation errors
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Validation error",
      details: err.flatten().fieldErrors,
    });
    return;
  }

  // Known HTTP errors (thrown with .status)
  if (err instanceof Error) {
    const status = (err as any).status as number | undefined;
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: err.message });
      return;
    }
  }

  // Unknown / server errors — don't leak internals
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
}
