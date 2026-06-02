const crypto = require("crypto");

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyFathomWebhookSignature({ secret, headers = {}, rawBody = "", now = new Date() }) {
  if (!secret) return false;
  const id = headers["webhook-id"] || headers["Webhook-Id"];
  const timestamp = headers["webhook-timestamp"] || headers["Webhook-Timestamp"];
  const signatureHeader = headers["webhook-signature"] || headers["Webhook-Signature"];
  if (!id || !timestamp || !signatureHeader) return false;

  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs)) return false;
  if (Math.abs(now.getTime() - timestampMs) > 5 * 60 * 1000) return false;

  const normalizedSecret = String(secret).startsWith("whsec_")
    ? Buffer.from(String(secret).slice(6), "base64")
    : Buffer.from(String(secret));
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", normalizedSecret).update(signedContent).digest("base64");
  return String(signatureHeader)
    .split(",")
    .map((signature) => signature.trim().replace(/^v\d+,?/, ""))
    .some((signature) => timingSafeEqual(signature, expected));
}

module.exports = { verifyFathomWebhookSignature };
