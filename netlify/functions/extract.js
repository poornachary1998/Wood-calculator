const Busboy = require("busboy");
const { ACCEPTED_MIME_TYPES, hasAnyRows, extractFromImage } = require("../../lib/gemini");

// Netlify Functions run behind API Gateway, which caps request bodies at 6MB.
// A base64-encoded upload is ~33% larger than the original file, so cap the
// raw image well below that ceiling.
const MAX_FUNCTION_UPLOAD_BYTES = 4 * 1024 * 1024;

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function errorResponse(statusCode, code, message) {
  return jsonResponse(statusCode, { error: { code, message } });
}

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const contentType =
      event.headers["content-type"] || event.headers["Content-Type"];

    if (!contentType) {
      reject(new Error("Missing content-type header"));
      return;
    }

    const busboy = Busboy({
      headers: { "content-type": contentType },
      limits: { fileSize: MAX_FUNCTION_UPLOAD_BYTES },
    });

    let fileBuffer = null;
    let mimetype = null;
    let fileTooLarge = false;

    busboy.on("file", (fieldname, file, info) => {
      const chunks = [];
      mimetype = info.mimeType;
      file.on("data", (chunk) => chunks.push(chunk));
      file.on("limit", () => {
        fileTooLarge = true;
      });
      file.on("end", () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });

    busboy.on("finish", () => resolve({ fileBuffer, mimetype, fileTooLarge }));
    busboy.on("error", reject);

    busboy.end(Buffer.from(event.body || "", event.isBase64Encoded ? "base64" : "utf8"));
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return errorResponse(405, "method_not_allowed", "Only POST is supported.");
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set.");
    return errorResponse(
      500,
      "server_misconfigured",
      "Server is missing configuration."
    );
  }

  let fileBuffer, mimetype, fileTooLarge;
  try {
    ({ fileBuffer, mimetype, fileTooLarge } = await parseMultipart(event));
  } catch (err) {
    return errorResponse(
      400,
      "invalid_upload",
      "Could not parse the uploaded image."
    );
  }

  if (fileTooLarge) {
    return errorResponse(
      413,
      "too_large",
      "The image is too large. Please upload a photo under 4MB."
    );
  }

  if (!fileBuffer || !mimetype) {
    return errorResponse(400, "no_image", "No image was uploaded.");
  }

  if (!ACCEPTED_MIME_TYPES.has(mimetype)) {
    return errorResponse(
      400,
      "unsupported_format",
      "Unsupported image format. Please upload a JPEG, PNG, WEBP, or HEIC photo."
    );
  }

  const base64Data = fileBuffer.toString("base64");

  let result;
  try {
    result = await extractFromImage(base64Data, mimetype);
  } catch (err) {
    if (err.isRateLimit) {
      return errorResponse(
        429,
        "rate_limited",
        "The service is busy right now. Please try again in a moment."
      );
    }
    console.error("Gemini API error:", err);
    return errorResponse(
      502,
      "upstream_error",
      "Something went wrong talking to the extraction service."
    );
  }

  if (result === null) {
    return errorResponse(
      422,
      "invalid_json",
      "Couldn't read this photo clearly. Try a clearer, closer, or better-lit photo."
    );
  }

  if (!hasAnyRows(result)) {
    return errorResponse(
      422,
      "no_rows_found",
      "No measurement rows were found in this photo. Try a clearer, closer, or better-lit photo."
    );
  }

  return jsonResponse(200, result);
};
