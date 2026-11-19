import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(200).json({
    ok: true,
    provider: "kimi",
    model: process.env.LLM_MODEL || "kimi-k2.6",
    runtime: "vercel-serverless",
  });
}
