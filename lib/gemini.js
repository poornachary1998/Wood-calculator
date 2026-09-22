const GEMINI_MODEL = "gemini-3-flash-preview";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ACCEPTED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
]);

const EXTRACTION_PROMPT = `You are reading a handwritten wood-cutting measurement list from a
photo. Each line generally follows the pattern: QUANTITY - DIMENSION x
DIMENSION x DIMENSION, sometimes followed by a hand-written decimal
result (ignore that trailing number; do not include it). Dimensions may
be mixed-number fractions such as 4¼, 1½, 3¾, or written as "1 3/4"
meaning 1.75 — convert every fraction to its decimal equivalent. Group
the lines into sections using any headings, dividers, or clear breaks
visible in the photo (headings may be in Telugu or English — carry the
heading text through as the section name if legible, otherwise name
sections "Section 1", "Section 2", etc. in the order they appear on
the page). Read every line you can, top to bottom, left column before
right column if the page is split into columns. Reply with ONLY a JSON
object of exactly this shape, no other text: {"sections":[{"name":
"string","rows":[{"qty":number,"values":[number,number,...]}]}]}`;

function stripCodeFences(text) {
  let stripped = text.trim();
  const fenced = stripped.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) {
    stripped = fenced[1].trim();
  }
  return stripped;
}

function isValidExtraction(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.sections)) {
    return false;
  }
  return data.sections.every((section) => {
    if (
      !section ||
      typeof section.name !== "string" ||
      !Array.isArray(section.rows)
    ) {
      return false;
    }
    return section.rows.every((row) => {
      return (
        row &&
        typeof row.qty === "number" &&
        Array.isArray(row.values) &&
        row.values.every((v) => typeof v === "number")
      );
    });
  });
}

function hasAnyRows(data) {
  return data.sections.some(
    (section) => Array.isArray(section.rows) && section.rows.length > 0
  );
}

async function callGeminiExtract(base64Data, mediaType) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(
      `${GEMINI_ENDPOINT}?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: EXTRACTION_PROMPT },
                { inline_data: { mime_type: mediaType, data: base64Data } },
              ],
            },
          ],
          generationConfig: { responseMimeType: "application/json" },
        }),
      }
    );
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 429) {
    const err = new Error("Gemini API rate limit hit");
    err.isRateLimit = true;
    err.retryAfterHeader = response.headers.get("retry-after");
    throw err;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Gemini API error: ${response.status} ${body}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    return null;
  }

  try {
    const cleaned = stripCodeFences(text);
    const parsed = JSON.parse(cleaned);
    if (!isValidExtraction(parsed)) {
      return null;
    }
    return parsed;
  } catch (err) {
    return null;
  }
}

async function callGeminiWithRateLimitRetry(base64Data, mediaType) {
  try {
    return await callGeminiExtract(base64Data, mediaType);
  } catch (err) {
    if (err.isRateLimit) {
      const delayMs = err.retryAfterHeader
        ? parseInt(err.retryAfterHeader, 10) * 1000
        : 2000;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return callGeminiExtract(base64Data, mediaType);
    }
    throw err;
  }
}

async function extractFromImage(base64Data, mediaType) {
  let result = await callGeminiWithRateLimitRetry(base64Data, mediaType);
  if (result === null) {
    // First attempt failed to parse/validate — retry once with an identical request.
    result = await callGeminiWithRateLimitRetry(base64Data, mediaType);
  }
  return result;
}

module.exports = {
  MAX_UPLOAD_BYTES,
  ACCEPTED_MIME_TYPES,
  isValidExtraction,
  hasAnyRows,
  extractFromImage,
};
