import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(200).json({
    ok: true,
    provider: "anthropic",
    model: process.env.LLM_MODEL || "claude-sonnet-4-20250514",
    runtime: "vercel-serverless",
  });
}
