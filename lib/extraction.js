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
// 429 (quota or rate limit) is not retried on the same key: the chain moves
// straight on to the next model or the backup key, which keeps the whole
// request inside Netlify's function time limit.
const RETRYABLE_STATUSES = new Set([503]);

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
// GEMINI_API_KEY_BACKUP is an optional second Gemini key (ideally from a
// different Google Cloud project, since quota is shared per project) that
// takes over when the main key's quota is used up or the key stops working.
const EXTRACTION_CHAIN = [
  { id: "gemini-3-flash", envKey: "GEMINI_API_KEY", callRaw: (b64, mt) => callGeminiRaw("gemini-3-flash-preview", b64, mt, process.env.GEMINI_API_KEY) },
  { id: "gemini-3.1-flash-lite", envKey: "GEMINI_API_KEY", callRaw: (b64, mt) => callGeminiRaw("gemini-3.1-flash-lite", b64, mt, process.env.GEMINI_API_KEY) },
  { id: "gemini-3-flash (backup key)", envKey: "GEMINI_API_KEY_BACKUP", callRaw: (b64, mt) => callGeminiRaw("gemini-3-flash-preview", b64, mt, process.env.GEMINI_API_KEY_BACKUP) },
  { id: "gemini-3.1-flash-lite (backup key)", envKey: "GEMINI_API_KEY_BACKUP", callRaw: (b64, mt) => callGeminiRaw("gemini-3.1-flash-lite", b64, mt, process.env.GEMINI_API_KEY_BACKUP) },
  { id: "claude-sonnet-5", envKey: "ANTHROPIC_API_KEY", callRaw: (b64, mt) => callClaudeRaw("claude-sonnet-5", b64, mt) },
];

const PROVIDER_ENV_KEYS = [...new Set(EXTRACTION_CHAIN.map((entry) => entry.envKey))];

function hasAnyProviderKey() {
  return PROVIDER_ENV_KEYS.some((key) => Boolean(process.env[key]));
}

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

// Builds an Error carrying the provider's HTTP status and response body, so
// failures can be logged in full and classified (quota, bad key, ...).
async function apiError(provider, response) {
  const body = await response.text().catch(() => "");
  const err = new Error(`${provider} API error: ${response.status}`);
  err.status = response.status;
  err.body = body;
  return err;
}

// Never let an API key reach the logs, whatever the error text contains.
function redactSecrets(text) {
  let out = String(text);
  for (const key of PROVIDER_ENV_KEYS.map((name) => process.env[name])) {
    if (key) out = out.split(key).join("[REDACTED]");
  }
  return out;
}

function describeError(err) {
  if (err.isTimeout) return `timed out after ${REQUEST_TIMEOUT_MS / 1000}s`;
  const parts = [err.message];
  if (err.body) parts.push(err.body.slice(0, 1000));
  if (err.cause) parts.push(`cause: ${err.cause.message || err.cause}`);
  return redactSecrets(parts.join(" | "));
}

// Maps a failed provider call to the reason shown to the user.
function classifyError(err) {
  if (err.isTimeout) return "provider_timeout";
  const body = err.body || "";
  if (err.status === 429 || /RESOURCE_EXHAUSTED|quota|credit balance/i.test(body)) {
    return "quota_exceeded";
  }
  if (err.status === 401 || err.status === 403 || /API_KEY_INVALID|API key not valid|invalid x-api-key/i.test(body)) {
    return "invalid_api_key";
  }
  if (err.status === 404) return "model_not_found";
  return "upstream_error";
}

// When providers fail for different reasons, report the one the shop owner
// is most likely able to act on.
const FAILURE_PRIORITY = ["quota_exceeded", "invalid_api_key", "model_not_found", "provider_timeout", "upstream_error"];

// HTTP status and user-facing message for each provider failure code.
const PROVIDER_FAILURES = {
  quota_exceeded: {
    status: 429,
    message: "The AI service's usage limit has been reached. Wait a minute and try again; if it keeps happening, today's quota is used up.",
  },
  invalid_api_key: {
    status: 502,
    message: "The AI service rejected the API key. Check the API key in the server settings.",
  },
  model_not_found: {
    status: 502,
    message: "The AI model configured on the server is no longer available.",
  },
  provider_timeout: {
    status: 504,
    message: "The AI service took too long to respond. Please try again.",
  },
  upstream_error: {
    status: 502,
    message: "Something went wrong talking to the extraction service.",
  },
};

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

async function callGeminiRaw(model, base64Data, mediaType, apiKey) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const response = await withTimeout((signal) =>
    fetch(`${endpoint}?key=${apiKey}`, {
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

  if (!response.ok) {
    throw await apiError("Gemini", response);
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

  if (!response.ok) {
    throw await apiError("Claude", response);
  }

  const data = await response.json();
  const block = Array.isArray(data?.content)
    ? data.content.find((b) => b.type === "text")
    : null;
  return block?.text || "";
}

// Runs one chain entry with retries. Returns { ok: true, data } on success,
// or { ok: false, failureType: "call" | "parse", reason } once retries are
// exhausted, where reason is a PROVIDER_FAILURES code for call failures.
async function attemptEntry(entry, base64Data, mediaType) {
  let failureType = "call";
  let reason = "upstream_error";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let text;
    try {
      text = await entry.callRaw(base64Data, mediaType);
    } catch (err) {
      failureType = "call";
      reason = classifyError(err);
      console.error(`[extract] ${entry.id} attempt ${attempt + 1} failed (${reason}): ${describeError(err)}`);
      if (isRetryable(err) && attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS[attempt]);
        continue;
      }
      return { ok: false, failureType, reason };
    }

    const parsed = parseExtractionJson(text);
    if (parsed !== null) {
      return { ok: true, data: parsed };
    }

    failureType = "parse";
    console.error(`[extract] ${entry.id} attempt ${attempt + 1} returned unparseable output: ${redactSecrets(text.slice(0, 500))}`);
    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_BACKOFF_MS[attempt]);
      continue;
    }
    return { ok: false, failureType };
  }

  return { ok: false, failureType, reason };
}

// Walks EXTRACTION_CHAIN in order, skipping entries without a configured key.
// Throws with err.code set to:
//   "no_provider_configured" — every entry was skipped (nothing to try)
//   "invalid_json"           — every attempted entry returned unparseable output
//   a PROVIDER_FAILURES code — at least one attempted entry hit a network/HTTP
//                              failure; the most actionable reason is reported
async function extractFromImage(base64Data, mediaType) {
  let attemptedAny = false;
  const callFailures = [];

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
      callFailures.push(outcome.reason);
    }
  }

  if (!attemptedAny) {
    const err = new Error("No extraction provider has an API key configured");
    err.code = "no_provider_configured";
    throw err;
  }

  const err = new Error("All providers in the extraction chain failed");
  err.code = callFailures.length > 0
    ? FAILURE_PRIORITY.find((code) => callFailures.includes(code))
    : "invalid_json";
  throw err;
}

module.exports = {
  MAX_UPLOAD_BYTES,
  ACCEPTED_MIME_TYPES,
  PROVIDER_FAILURES,
  PROVIDER_ENV_KEYS,
  hasAnyProviderKey,
  hasAnyRows,
  extractFromImage,
};
