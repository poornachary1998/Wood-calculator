require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const {
  MAX_UPLOAD_BYTES,
  ACCEPTED_MIME_TYPES,
  hasAnyRows,
  extractFromImage,
} = require("./lib/extraction");

const PORT = process.env.PORT || 3000;

if (!process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  console.error(
    "No extraction provider is configured. Copy .env.example to .env and set at least one of GEMINI_API_KEY or ANTHROPIC_API_KEY."
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
    result = await extractFromImage(base64Data, mediaType);
  } catch (err) {
    console.error("Extraction chain failed:", err);
    if (err.code === "no_provider_configured") {
      return sendError(
        res,
        500,
        "server_misconfigured",
        "The server is missing extraction API credentials."
      );
    }
    if (err.code === "invalid_json") {
      return sendError(
        res,
        422,
        "invalid_json",
        "Couldn't read this photo clearly. Try a clearer, closer, or better-lit photo."
      );
    }
    return sendError(
      res,
      502,
      "upstream_error",
      "Something went wrong talking to the extraction service."
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
