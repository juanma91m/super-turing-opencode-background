import crypto from "node:crypto";
import fs from "node:fs/promises";

export async function sha256File(filePath) {
  const content = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}
