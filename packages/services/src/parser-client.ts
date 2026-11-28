import { request } from "node:http";
import { HttpError } from "@repo/common";

export function isolatedParse(socketPath: string, path: string, bytes: Buffer) {
  return new Promise<string>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method: "POST",
        headers: { "Content-Length": bytes.length },
        signal: AbortSignal.timeout(20000),
      },
      (res) => {
        const buffers: Buffer[] = [];
        let size = 0;
        res.on("data", (part: Buffer) => {
          size += part.length;
          if (size > 1024 * 1024)
            res.destroy(new Error("PDF parser output exceeded its limit"));
          else buffers.push(part);
        });
        res.once("error", reject);
        res.once("end", () => {
          const result = Buffer.concat(buffers).toString("utf8");
          if (res.statusCode === 200) resolve(result);
          else
            reject(
              new HttpError(
                res.statusCode === 422 ? 422 : 503,
                res.statusCode === 422
                  ? "Invalid, encrypted, or unreadable PDF"
                  : "PDF parser unavailable",
              ),
            );
        });
      },
    );
    req.on("error", reject);
    req.end(bytes);
  });
}
