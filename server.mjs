import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { authorizeBasicRequest } from "./basic-auth.mjs";

export const OCR_PROMPT = [
  "画像内の文字をOCRしてください。",
  "- 要約、説明、翻訳、推測、補完をしない",
  "- 見える文字だけを自然な読み順で出力する",
  "- 改行、段落、箇条書き、表の並びを可能な限り維持する",
  "- 判別できない箇所は [判読不能] と書く",
  "- 文字がない場合は「テキストなし」とだけ出力する",
  "- 回答にはOCR本文だけを含める",
].join("\n");

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(MODULE_DIR, "static", "index.html");
const IMAGE_PROCESSING_PATH = resolve(MODULE_DIR, "static", "image-processing.mjs");
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 28 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 360_000;
const SUPPORTED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

class HttpError extends Error {
  constructor(status, message, code = "request_error") {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function getConfig(overrides = {}) {
  return {
    host: overrides.host ?? process.env.LOCAL_OCR_HOST ?? "127.0.0.1",
    port: Number(overrides.port ?? process.env.LOCAL_OCR_PORT ?? process.env.PORT ?? 8005),
    model: overrides.model ?? process.env.LOCAL_OCR_MODEL ?? "qwen3.5:9b",
    ollamaBaseUrl:
      overrides.ollamaBaseUrl ??
      process.env.OLLAMA_BASE_URL ??
      "http://127.0.0.1:11434",
    timeoutMs: Number(
      overrides.timeoutMs ?? process.env.LOCAL_OCR_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
    ),
    maxImageBytes: Number(
      overrides.maxImageBytes ??
        process.env.LOCAL_OCR_MAX_IMAGE_BYTES ??
        DEFAULT_MAX_IMAGE_BYTES,
    ),
    maxRequestBytes: Number(
      overrides.maxRequestBytes ??
        process.env.LOCAL_OCR_MAX_REQUEST_BYTES ??
        DEFAULT_MAX_REQUEST_BYTES,
    ),
  };
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function sendNoContent(response) {
  response.writeHead(204, { "Cache-Control": "no-store" });
  response.end();
}

async function sendIndex(response) {
  const body = await readFile(INDEX_PATH);
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  response.end(body);
}

async function sendImageProcessingModule(response) {
  const body = await readFile(IMAGE_PROCESSING_PATH);
  response.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function readJsonBody(request, maxBytes) {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "JSON形式で画像を送信してください。", "unsupported_media_type");
  }

  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (declaredLength > maxBytes) {
    throw new HttpError(413, "画像データが大きすぎます。", "request_too_large");
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new HttpError(413, "画像データが大きすぎます。", "request_too_large");
    }
    chunks.push(chunk);
  }

  if (total === 0) {
    throw new HttpError(400, "画像を選択してください。", "empty_request");
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "画像データを読み取れませんでした。", "invalid_json");
  }
}

function matchesImageSignature(mimeType, buffer) {
  if (mimeType === "image/jpeg") {
    return (
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    );
  }
  if (mimeType === "image/png") {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return buffer.length >= signature.length && buffer.subarray(0, 8).equals(signature);
  }
  if (mimeType === "image/webp") {
    return (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  return false;
}

export function decodeImageData(dataUrl, maxImageBytes = DEFAULT_MAX_IMAGE_BYTES) {
  if (typeof dataUrl !== "string") {
    throw new HttpError(400, "画像を選択してください。", "missing_image");
  }

  const match = /^data:(image\/(?:jpeg|png|webp));base64,([a-z0-9+/=\r\n]+)$/i.exec(
    dataUrl,
  );
  if (!match) {
    throw new HttpError(
      400,
      "JPEG、PNG、WebPの画像を選択してください。",
      "unsupported_image",
    );
  }

  const mimeType = match[1].toLowerCase();
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new HttpError(400, "この画像形式には対応していません。", "unsupported_image");
  }

  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length === 0) {
    throw new HttpError(400, "画像データが空です。", "empty_image");
  }
  if (buffer.length > maxImageBytes) {
    throw new HttpError(413, "画像は20MB以下にしてください。", "image_too_large");
  }
  if (!matchesImageSignature(mimeType, buffer)) {
    throw new HttpError(400, "画像データが壊れているか、形式が一致しません。", "invalid_image");
  }

  return { mimeType, buffer };
}

export function buildOllamaPayload(imageBuffer, model) {
  return {
    model,
    prompt: OCR_PROMPT,
    images: [imageBuffer.toString("base64")],
    stream: false,
    think: false,
    keep_alive: "2m",
    options: {
      num_ctx: 8192,
      temperature: 0,
      num_predict: 4096,
    },
  };
}

async function parseResponseJson(response) {
  try {
    return await response.json();
  } catch {
    throw new HttpError(502, "ローカルLLMから不正な応答がありました。", "invalid_ollama_response");
  }
}

export async function callOllama(imageBuffer, config, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`${config.ollamaBaseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildOllamaPayload(imageBuffer, config.model)),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new HttpError(
        504,
        "OCR処理がタイムアウトしました。画像を小さくして再試行してください。",
        "ollama_timeout",
      );
    }
    throw new HttpError(
      503,
      "Ollamaに接続できません。自宅PCでOllamaが起動しているか確認してください。",
      "ollama_unavailable",
    );
  }

  const payload = await parseResponseJson(response);
  if (!response.ok) {
    const detail = typeof payload.error === "string" ? ` ${payload.error}` : "";
    throw new HttpError(
      502,
      `ローカルLLMの処理に失敗しました。${detail}`.trim(),
      "ollama_error",
    );
  }

  const text = typeof payload.response === "string" ? payload.response.trim() : "";
  if (!text) {
    throw new HttpError(502, "文字を抽出できませんでした。", "empty_ocr_result");
  }
  return text;
}

export async function checkOllama(config, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${config.ollamaBaseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      return { ready: false, ollama: false, modelInstalled: false };
    }
    const payload = await response.json();
    const modelInstalled = (payload.models ?? []).some(
      (entry) => entry.name === config.model || entry.model === config.model,
    );
    return { ready: modelInstalled, ollama: true, modelInstalled };
  } catch {
    return { ready: false, ollama: false, modelInstalled: false };
  }
}

export function createHandler(options = {}) {
  const config = getConfig(options.config);
  const fetchImpl = options.fetchImpl ?? fetch;
  const state = options.state ?? { busy: false };
  const logger = options.logger ?? console;

  return async function handler(request, response) {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (!authorizeBasicRequest(request, response, "Local OCR", options.env ?? process.env)) {
      return;
    }

    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        await sendIndex(response);
        return;
      }
      if (request.method === "GET" && url.pathname === "/image-processing.mjs") {
        await sendImageProcessingModule(response);
        return;
      }
      if (request.method === "GET" && url.pathname === "/favicon.ico") {
        sendNoContent(response);
        return;
      }
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          status: "ok",
          service: "local_ocr",
          busy: Boolean(state.busy),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        const health = await checkOllama(config, fetchImpl);
        sendJson(response, health.ready ? 200 : 503, {
          status: health.ready ? "ready" : "unavailable",
          model: config.model,
          busy: Boolean(state.busy),
          ollama: health.ollama,
          model_installed: health.modelInstalled,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/ocr") {
        if (state.busy) {
          throw new HttpError(
            429,
            "別のOCRを処理中です。少し待ってから再試行してください。",
            "ocr_busy",
          );
        }

        const payload = await readJsonBody(request, config.maxRequestBytes);
        const image = decodeImageData(payload.image, config.maxImageBytes);
        state.busy = true;
        const startedAt = performance.now();
        try {
          const text = await callOllama(image.buffer, config, fetchImpl);
          const elapsedMs = Math.round(performance.now() - startedAt);
          logger.info?.(
            `[local_ocr] success model=${config.model} bytes=${image.buffer.length} elapsed_ms=${elapsedMs}`,
          );
          sendJson(response, 200, {
            text,
            model: config.model,
            elapsed_ms: elapsedMs,
          });
        } finally {
          state.busy = false;
        }
        return;
      }

      sendJson(response, 404, { error: "ページが見つかりません。", code: "not_found" });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message =
        error instanceof HttpError
          ? error.message
          : "予期しないエラーが発生しました。";
      const code = error instanceof HttpError ? error.code : "internal_error";
      if (status >= 500) {
        logger.error?.(`[local_ocr] error code=${code} message=${error?.message ?? error}`);
      }
      if (!response.headersSent) {
        sendJson(response, status, { error: message, code });
      } else {
        response.end();
      }
    }
  };
}

export function startServer(overrides = {}) {
  const config = getConfig(overrides);
  const server = createServer(createHandler({ config }));
  server.listen(config.port, config.host, () => {
    console.log(`local_ocr: http://${config.host}:${config.port}`);
    console.log(`model: ${config.model}`);
  });
  return server;
}

function parseServeArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--host" && args[index + 1]) {
      result.host = args[index + 1];
      index += 1;
    } else if (arg === "--port" && args[index + 1]) {
      result.port = Number(args[index + 1]);
      index += 1;
    } else if (arg === "--no-browser") {
      // server_managerとCLIの共通インターフェース用。ブラウザは元から開かない。
    } else {
      throw new Error(`不明なオプションです: ${arg}`);
    }
  }
  return result;
}

export async function runDoctor(overrides = {}, fetchImpl = fetch) {
  const config = getConfig(overrides);
  const checks = [];
  const majorVersion = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "Node.js 18以上",
    ok: majorVersion >= 18,
    detail: process.version,
  });

  const health = await checkOllama(config, fetchImpl);
  checks.push({
    name: "Ollama API",
    ok: health.ollama,
    detail: config.ollamaBaseUrl,
  });
  checks.push({
    name: `OCRモデル ${config.model}`,
    ok: health.modelInstalled,
    detail: health.modelInstalled ? "インストール済み" : "見つかりません",
  });

  for (const check of checks) {
    console.log(`${check.ok ? "OK" : "NG"}  ${check.name}: ${check.detail}`);
  }
  return checks.every((check) => check.ok) ? 0 : 1;
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0] ?? "serve";
  if (command === "doctor") {
    return runDoctor();
  }
  if (command === "serve") {
    const options = parseServeArgs(args.slice(1));
    startServer(options);
    return 0;
  }
  console.error("使い方: node server.mjs [serve|doctor] [--host HOST] [--port PORT]");
  return 2;
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryPath) {
  const exitCode = await main();
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
