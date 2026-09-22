require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");

const PORT = process.env.PORT || 3000;
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

if (!process.env.GEMINI_API_KEY) {
  console.error(
    "GEMINI_API_KEY is not set. Copy .env.example to .env and add your key."
  );
  process.exit(1);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

const app = express();
app.use(cors());
app.use(express.static("public"));

function sendError(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

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

app.post("/api/extract", upload.single("image"), async (req, res) => {
  if (!req.file) {
    return sendError(res, 400, "no_image", "No image was uploaded.");
  }

  if (!ACCEPTED_MIME_TYPES.has(req.file.mimetype)) {
    return sendError(
      res,
      400,
      "unsupported_format",
      "Unsupported image format. Please upload a JPEG, PNG, WEBP, or HEIC photo."
    );
  }

  const base64Data = req.file.buffer.toString("base64");
  const mediaType = req.file.mimetype;

  let result;
  try {
    result = await callGeminiWithRateLimitRetry(base64Data, mediaType);
  } catch (err) {
    if (err.isRateLimit) {
      return sendError(
        res,
        429,
        "rate_limited",
        "The service is busy right now. Please try again in a moment."
      );
    }
    console.error("Gemini API error:", err);
    return sendError(
      res,
      502,
      "upstream_error",
      "Something went wrong talking to the extraction service."
    );
  }

  if (result === null) {
    // First attempt failed to parse/validate — retry once with an identical request.
    try {
      result = await callGeminiWithRateLimitRetry(base64Data, mediaType);
    } catch (err) {
      if (err.isRateLimit) {
        return sendError(
          res,
          429,
          "rate_limited",
          "The service is busy right now. Please try again in a moment."
        );
      }
      console.error("Gemini API error on retry:", err);
      return sendError(
        res,
        502,
        "upstream_error",
        "Something went wrong talking to the extraction service."
      );
    }
  }

  if (result === null) {
    return sendError(
      res,
      422,
      "invalid_json",
      "Couldn't read this photo clearly. Try a clearer, closer, or better-lit photo."
    );
  }

  if (!hasAnyRows(result)) {
    return sendError(
      res,
      422,
      "no_rows_found",
      "No measurement rows were found in this photo. Try a clearer, closer, or better-lit photo."
    );
  }

  res.status(200).json(result);
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return sendError(
      res,
      413,
      "too_large",
      "The image is too large. Please upload a photo under 10MB."
    );
  }
  console.error("Unexpected error:", err);
  sendError(res, 502, "upstream_error", "An unexpected error occurred.");
});

app.listen(PORT, () => {
  console.log(`Wood cut-list extractor running at http://localhost:${PORT}`);
});
