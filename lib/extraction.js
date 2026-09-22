const REQUEST_TIMEOUT_MS = 45 * 1000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ACCEPTED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
]);

const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = [1000, 2000];
const RETRYABLE_STATUSES = new Set([429, 503]);

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

// Tried in order. Each entry is skipped if its env key isn't set, and gets
// MAX_RETRIES backoff retries on a retryable failure before the chain moves on.
const EXTRACTION_CHAIN = [
  { id: "gemini-3-flash", envKey: "GEMINI_API_KEY", callRaw: (b64, mt) => callGeminiRaw("gemini-3-flash-preview", b64, mt) },
  { id: "gemini-3.1-flash-lite", envKey: "GEMINI_API_KEY", callRaw: (b64, mt) => callGeminiRaw("gemini-3.1-flash-lite", b64, mt) },
  { id: "claude-sonnet-5", envKey: "ANTHROPIC_API_KEY", callRaw: (b64, mt) => callClaudeRaw("claude-sonnet-5", b64, mt) },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function parseExtractionJson(text) {
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

function isRetryable(err) {
  return Boolean(err.isTimeout || (err.status && RETRYABLE_STATUSES.has(err.status)));
}

async function withTimeout(run) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } catch (err) {
    if (err.name === "AbortError") {
      const timeoutErr = new Error("Request timed out");
      timeoutErr.isTimeout = true;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function callGeminiRaw(model, base64Data, mediaType) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const response = await withTimeout((signal) =>
    fetch(`${endpoint}?key=${process.env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
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
    })
  );

  if (RETRYABLE_STATUSES.has(response.status)) {
    const err = new Error(`Gemini API error: ${response.status}`);
    err.status = response.status;
    throw err;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Gemini API error: ${response.status} ${body}`);
  }

  const data = await response.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function callClaudeRaw(model, base64Data, mediaType) {
  const response = await withTimeout((signal) =>
    fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      signal,
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: EXTRACTION_PROMPT },
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: base64Data },
              },
            ],
          },
        ],
      }),
    })
  );

  if (RETRYABLE_STATUSES.has(response.status)) {
    const err = new Error(`Claude API error: ${response.status}`);
    err.status = response.status;
    throw err;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Claude API error: ${response.status} ${body}`);
  }

  const data = await response.json();
  const block = Array.isArray(data?.content)
    ? data.content.find((b) => b.type === "text")
    : null;
  return block?.text || "";
}

// Runs one chain entry with retries. Returns { ok: true, data } on success,
// or { ok: false, failureType: "call" | "parse" } once retries are exhausted.
async function attemptEntry(entry, base64Data, mediaType) {
  let failureType = "call";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let text;
    try {
      text = await entry.callRaw(base64Data, mediaType);
    } catch (err) {
      failureType = "call";
      if (isRetryable(err) && attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS[attempt]);
        continue;
      }
      return { ok: false, failureType };
    }

    const parsed = parseExtractionJson(text);
    if (parsed !== null) {
      return { ok: true, data: parsed };
    }

    failureType = "parse";
    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_BACKOFF_MS[attempt]);
      continue;
    }
    return { ok: false, failureType };
  }

  return { ok: false, failureType };
}

// Walks EXTRACTION_CHAIN in order, skipping entries without a configured key.
// Throws with err.code set to:
//   "no_provider_configured" — every entry was skipped (nothing to try)
//   "invalid_json"           — every attempted entry returned unparseable output
//   "upstream_error"         — at least one attempted entry hit a network/HTTP failure
async function extractFromImage(base64Data, mediaType) {
  let attemptedAny = false;
  let sawCallFailure = false;

  for (const entry of EXTRACTION_CHAIN) {
    if (!process.env[entry.envKey]) {
      continue;
    }
    attemptedAny = true;

    const outcome = await attemptEntry(entry, base64Data, mediaType);
    if (outcome.ok) {
      return outcome.data;
    }
    if (outcome.failureType === "call") {
      sawCallFailure = true;
    }
  }

  if (!attemptedAny) {
    const err = new Error("No extraction provider has an API key configured");
    err.code = "no_provider_configured";
    throw err;
  }

  const err = new Error("All providers in the extraction chain failed");
  err.code = sawCallFailure ? "upstream_error" : "invalid_json";
  throw err;
}

module.exports = {
  MAX_UPLOAD_BYTES,
  ACCEPTED_MIME_TYPES,
  hasAnyRows,
  extractFromImage,
};
