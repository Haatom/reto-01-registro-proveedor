import type { VercelRequest, VercelResponse } from "@vercel/node";
import { existsSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const __filename_esm = fileURLToPath(import.meta.url);
  const __dirname_esm = dirname(__filename_esm);
  const projectDir = resolve(join(__dirname_esm, ".."));
  const cwd = process.cwd();

  const paths = {
    "__filename (import.meta.url)": __filename_esm,
    "__dirname (import.meta.url)": __dirname_esm,
    "PROJECT_DIR (dirname/..)": projectDir,
    "process.cwd()": cwd,
  };

  const checks: Record<string, boolean | string[]> = {};

  // Check fixtures with PROJECT_DIR
  const fixPath1 = join(projectDir, "fixtures", "reto-01", "casos");
  checks[`existsSync(${fixPath1})`] = existsSync(fixPath1);
  if (existsSync(fixPath1)) {
    checks[`readdirSync(${fixPath1})`] = readdirSync(fixPath1);
  }

  // Check fixtures with cwd
  const fixPath2 = join(cwd, "fixtures", "reto-01", "casos");
  checks[`existsSync(${fixPath2})`] = existsSync(fixPath2);
  if (existsSync(fixPath2)) {
    checks[`readdirSync(${fixPath2})`] = readdirSync(fixPath2);
  }

  // List root dir contents
  try { checks[`readdirSync(${projectDir})`] = readdirSync(projectDir); } catch (e: any) { checks[`readdirSync(${projectDir})`] = [e.message]; }
  try { checks[`readdirSync(${cwd})`] = readdirSync(cwd); } catch (e: any) { checks[`readdirSync(${cwd})`] = [e.message]; }

  // Check agent/prompt.md
  const agentPath = join(projectDir, "agent", "prompt.md");
  checks[`existsSync(${agentPath})`] = existsSync(agentPath);

  return res.status(200).json({ paths, checks });
}
