import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(200).json({
    ok: true,
    provider: "openai",
    model: process.env.LLM_MODEL || "gpt-4o-mini",
    runtime: "vercel-serverless",
  });
}
