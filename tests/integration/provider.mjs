// Test-only OpenAI wire adapter. Read values from the supplied invoice so uploading
// the wrong revision fails the carry-over assertion. Never enabled by compose.yaml.
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const invoiceFields = {
  invoice_number: /Invoice Number:\s*(\S+)/,
  issue_date: /Issue Date:\s*(\S+)/,
  due_date: /Due Date:\s*(\S+)/,
  vendor_name: /(MERIDIAN OFFICE SUPPLIES LLC)/,
  total_amount: /Total Due:\s*(\$[\d,.]+)/,
};

createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    let result;
    if (req.url === "/v1/embeddings") {
      result = {
        data: data.input.map((_, index) => ({
          index,
          embedding: Array.from({ length: 1536 }, (_, i) => Number(i === 0)),
        })),
      };
    } else if (data.tool_choice?.function?.name === "retrieve") {
      const mode = data.messages.at(-1).content.includes("exact")
        ? "lexical"
        : "semantic";
      result = {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "review-search",
                  type: "function",
                  function: {
                    name: "retrieve",
                    arguments: JSON.stringify({ mode, query: "Meridian" }),
                  },
                },
              ],
            },
          },
        ],
      };
    } else if (data.response_format?.json_schema?.name === "cited_answer") {
      const sources = JSON.parse(data.messages.at(-1).content);
      const vendor = sources.find(
        (source) => source.reviewed && source.field === "vendor_name",
      );
      const answer = vendor
        ? { answer: vendor.value, sources: [vendor.id] }
        : { answer: "No reviewed vendor found.", sources: [] };
      result = {
        choices: [
          { message: { role: "assistant", content: JSON.stringify(answer) } },
        ],
      };
    } else if (
      data.response_format?.json_schema?.name === "document_extraction"
    ) {
      await delay(3000);
      const input = data.messages.at(-1).content;
      const values = Object.entries(invoiceFields).flatMap(([field, regex]) => {
        const match = input.match(regex);
        return match
          ? [{ field, value: match[1], quote: match[0], reason: null }]
          : [];
      });
      if (input.includes("MARKET REPORT"))
        values.push({
          field: "median_household_income",
          value: "$200",
          quote: "Synthetic invented income",
          reason: null,
        });
      result = {
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({ values, sectionStartLines: [1] }),
            },
          },
        ],
      };
    } else {
      res.writeHead(400).end("Unsupported test request");
      return;
    }
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(result));
  } catch {
    res.writeHead(400).end("Invalid test request");
  }
}).listen(4545, "0.0.0.0");
