import { createServer } from "node:http";
import { chmodSync, rmSync } from "node:fs";
import { parsePdf } from "./pdf.ts";
import { validatePdf } from "./ingest.ts";
import { config } from "@repo/config";

const socket = "/run/pdf-parser/parser.sock";
let active = 0;
const server = createServer(async (req, res) => {
  if (
    req.method !== "POST" ||
    !["/validate", "/text"].includes(req.url ?? "")
  ) {
    res.writeHead(404).end();
    return;
  }
  const size = Number(req.headers["content-length"]);
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > config.maxFileBytes ||
    active >= 4
  ) {
    res.writeHead(503, { connection: "close" }).end();
    return;
  }
  active++;
  try {
    const buffers: Buffer[] = [];
    let count = 0;
    for await (const part of req) {
      count += part.length;
      if (count > size) throw new Error("Size mismatch");
      buffers.push(part);
    }
    if (count !== size) throw new Error("Incomplete PDF");
    const bytes = Buffer.concat(buffers);
    const output =
      req.url === "/text" ? await parsePdf(bytes) : await validatePdf(bytes);
    res.writeHead(200).end(output ?? "");
  } catch {
    res.writeHead(422).end();
  } finally {
    active--;
  }
});
server.requestTimeout = 20000;
rmSync(socket, { force: true });
server.listen(socket, () => chmodSync(socket, 0o666));
