require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const {
  MAX_UPLOAD_BYTES,
  ACCEPTED_MIME_TYPES,
  hasAnyRows,
  extractFromImage,
} = require("./lib/gemini");

const PORT = process.env.PORT || 3000;

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
