import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const MAX_BYTES = 5 * 1024 * 1024;
const sessions = new Map();

function uploadSecret() {
  const secret = process.env.MCP_UPLOAD_SECRET || process.env.MCP_BEARER_TOKEN;
  return typeof secret === "string" && secret.length >= 16 ? secret : null;
}

export function uploadIntakeEnabled() {
  return Boolean(uploadSecret());
}

export function createUploadSession({ expectedSha256 = "", fileName = "template-header.png", contentType = "" } = {}) {
  const secret = uploadSecret();
  if (!secret) throw new Error("Upload intake is not configured.");
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new Error("A lowercase SHA-256 checksum is required.");
  }
  if (typeof fileName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(fileName)) {
    throw new Error("fileName must be a simple filename of 1 to 128 characters.");
  }
  if (contentType && !/^image\/(png|jpeg)$/.test(contentType)) throw new Error("Only image/png and image/jpeg are supported.");
  const token = randomBytes(32).toString("base64url");
  const createdAt = Date.now();
  const session = {
    token,
    expectedSha256: expectedSha256.toLowerCase(),
    fileName,
    contentType: contentType || null,
    createdAt,
    expiresAt: createdAt + 10 * 60 * 1000,
    used: false,
  };
  sessions.set(token, session);
  return { token, expiresAt: session.expiresAt, maxBytes: MAX_BYTES };
}

function validToken(token) {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export async function consumeUpload(req, token) {
  const secret = uploadSecret();
  if (!secret) throw new Error("Upload intake is not configured.");
  if (!validToken(token)) throw new Error("Invalid upload link.");
  const session = sessions.get(token);
  if (!session || session.used || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    throw new Error("Upload link is expired or already used.");
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BYTES) {
      req.destroy();
      throw new Error("Image exceeds 5 MiB.");
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (!bytes.length) throw new Error("No image bytes received.");
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  const expected = Buffer.from(session.expectedSha256, "hex");
  const actual = Buffer.from(actualSha256, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("Uploaded image failed checksum verification.");
  }
  session.used = true;
  sessions.delete(token);
  return { bytes, fileName: session.fileName, contentType: session.contentType, sha256: actualSha256 };
}

export function cleanupExpired(now = Date.now()) {
  for (const [token, session] of sessions) if (session.used || session.expiresAt <= now) sessions.delete(token);
}
