import { execFile } from "node:child_process";

export function parsePdf(bytes: Buffer): Promise<string> {
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")))
    return Promise.reject(new Error("Invalid PDF signature"));
  return new Promise((resolve, reject) => {
    const child = execFile(
      "pdftotext",
      ["-enc", "UTF-8", "-layout", "-", "-"],
      { timeout: 15000, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error)
          return reject(
            new Error(
              "PDF text parsing failed. Check that the file is readable and unencrypted.",
            ),
          );
        const text = stdout.replace(/\r\n/g, "\n").trimEnd();
        if (!text.trim())
          return reject(new Error("No readable text in this PDF"));
        // Bound the request context explicitly. Partial-text extraction would produce misleading gaps.
        if (text.length > 120000)
          return reject(
            new Error("PDF exceeds the 120,000-character extraction limit"),
          );
        resolve(text);
      },
    );
    child.stdin!.on("error", () => {
      /* The child exit callback reports parser failures. */
    });
    child.stdin!.end(bytes);
  });
}
