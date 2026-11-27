import type { RequestHandler } from "express";

// Each API process has one fixed window per IP and action group.
export function limit(max: number): RequestHandler {
  const clients = new Map<string, number>();
  let end = 0;
  return (req, res, next) => {
    const now = Date.now();
    if (now >= end) {
      clients.clear();
      end = now + 60_000;
    }
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const count = clients.get(key) ?? 0;
    if (count >= max) {
      res.set(
        "Retry-After",
        String(Math.max(1, Math.ceil((end - now) / 1000))),
      );
      res.status(429).json({
        message: "Rate limit reached. Retry after the indicated delay.",
      });
      return;
    }
    clients.set(key, count + 1);
    next();
  };
}
