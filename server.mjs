import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { authorizeBasicRequest } from "./basic-auth.mjs";
import { collectDiagnostics, inspectModel, GUIDANCE, validateConfig } from "./diagnostics.mjs";

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
const PWA_FILES = new Map([
  ["/static/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json"]],
  ["/static/pwa-icon-192.png", ["pwa-icon-192.png", "image/png"]],
  ["/static/pwa-icon-512.png", ["pwa-icon-512.png", "image/png"]],
  ["/static/sample-clear.png", ["sample-clear.png", "image/png"]],
  ["/static/sample-difficult.png", ["sample-difficult.png", "image/png"]],
  ["/static/sample-expected.txt", ["sample-expected.txt", "text/plain; charset=utf-8"]],
]);
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
      process.env.LOCAL_LLM_DISPATCHER_URL ??
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
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") throw error;
    throw new HttpError(502, "ローカルLLMの応答を読み取れませんでした。診断を更新し、Ollamaまたは接続先の状態を確認してください。", "invalid_ollama_response");
  }
}

export async function callOllama(imageBuffer, config, fetchImpl = fetch) {
  let response;
  let payload;
  try {
    response = await fetchImpl(`${config.ollamaBaseUrl}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LLM-Priority": "critical",
      },
      body: JSON.stringify(buildOllamaPayload(imageBuffer, config.model)),
      signal: AbortSignal.timeout(config.timeoutMs),
      redirect: "error",
    });
    payload = await parseResponseJson(response);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new HttpError(
        504,
        "待機時間を超えました。初回のモデル読込や混雑の可能性があります。処理が停止したかは未確認です。Ollamaの状態を確認し、画像を小さくするか待機上限を見直してください。",
        "ollama_timeout",
      );
    }
    throw new HttpError(
      503,
      GUIDANCE.ollama_unavailable,
      "ollama_unavailable",
    );
  }

  if (!response.ok) {
    // Upstream errors may contain user input or private paths. Never echo them.
    const detail = typeof payload.error === "string" ? payload.error : "";
    if (/out of memory|not enough (?:system )?memory|requires more (?:system )?memory|failed to allocate|unable to allocate|insufficient.*memory/i.test(detail)) {
      throw new HttpError(503, "Ollamaがメモリ確保の失敗を報告しました。他の負荷を確認してください。設定変更や別モデルへの切替は自動では行いません。", "ollama_memory");
    }
    if (response.status === 404 && /model.*not found/i.test(detail)) {
      throw new HttpError(503, GUIDANCE.model_missing, "model_missing");
    }
    if (response.status === 503) {
      throw new HttpError(503, "Ollamaが現在リクエストを受け付けられません。混雑やモデル読込失敗などの原因は未確認です。Ollamaの状態を確認し、しばらく待ってください。", "ollama_busy");
    }
    throw new HttpError(
      502,
      "ローカルLLMの処理に失敗しました。原因は未確認です。診断を再実行し、必要ならOllamaのログを手元で確認してください。",
      "ollama_error",
    );
  }

  if (payload.done === false || payload.done_reason === "length") {
    throw new HttpError(502, "出力が完了しませんでした。画像を文書の一部に分けて再試行してください。", "incomplete_ocr_result");
  }

  const text = typeof payload.response === "string" ? payload.response.trim() : "";
  if (!text) {
    throw new HttpError(502, "OCR本文が空でした。原因は未確認です。文字のあるサンプルで比較し、モデルと画像条件を確認してください。", "empty_ocr_result");
  }
  return { text, load_ms: Number.isFinite(payload.load_duration) && payload.load_duration >= 0 ? Math.round(payload.load_duration / 1e6) : null };
}

export async function checkOllama(config, fetchImpl = fetch) {
  return inspectModel(config, fetchImpl);
}

export function createHandler(options = {}) {
  const config = getConfig(options.config);
  const fetchImpl = options.fetchImpl ?? fetch;
  const state = options.state ?? { busy: false };
  const logger = options.logger ?? console;

  return async function handler(request, response) {
    if (!authorizeBasicRequest(request, response, "Local OCR", options.env ?? process.env)) {
      return;
    }

    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/healthz") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        await sendIndex(response);
        return;
      }
      if (request.method === "GET" && PWA_FILES.has(url.pathname)) {
        const [filename, contentType] = PWA_FILES.get(url.pathname);
        const body = await readFile(resolve(MODULE_DIR, "static", filename));
        response.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": body.length,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(body);
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
          code: health.code,
          guidance: GUIDANCE[health.code],
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/diagnostics") {
        sendJson(response, 200, await collectDiagnostics(config, fetchImpl, options.env ?? process.env));
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

        state.busy = true;
        const startedAt = performance.now();
        try {
          const payload = await readJsonBody(request, config.maxRequestBytes);
          const image = decodeImageData(payload?.image, config.maxImageBytes);
          const health = await checkOllama(config, fetchImpl);
          if (!health.ready) throw new HttpError(503, GUIDANCE[health.code], health.code);
          const result = await callOllama(image.buffer, config, fetchImpl);
          const elapsedMs = Math.round(performance.now() - startedAt);
          logger.info?.(
            `[local_ocr] success model=${config.model} bytes=${image.buffer.length} elapsed_ms=${elapsedMs}`,
          );
          sendJson(response, 200, {
            ...result,
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
        logger.error?.(`[local_ocr] error code=${code}`);
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
  if (!process.env.BASIC_AUTH_PASSWORD) throw new Error("BASIC_AUTH_PASSWORDを設定してください。READMEの .env 作成と --env-file 指定を確認してください。");
  if (!validateConfig(config)) throw new Error("設定が不正です。ポートは1〜65535、上限値は正の整数、接続先は認証情報・query・fragmentのないHTTP(S) URLを指定してください。");
  const server = createServer(createHandler({ config }));
  server.on("error", (error) => {
    console.error(error.code === "EADDRINUSE" ? "ポートが使用中です。既存アプリを確認するか --port 8006 など別のポートを指定してください。" : "起動できませんでした。待受ホスト・ポート・権限を確認してください。");
    process.exitCode = 1;
  });
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

export async function runDoctor(overrides = {}, fetchImpl = fetch, json = false) {
  const config = getConfig(overrides);
  const report = await collectDiagnostics(config, fetchImpl);
  const nodeOk = Number(process.versions.node.split(".")[0]) >= 24;
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${nodeOk ? "OK" : "NG"} Node.js 24以上: ${process.version}`);
    console.log(`${report.configuration.auth_configured ? "OK" : "NG"} Basic認証設定`);
    console.log(`${report.configuration.valid ? "OK" : "NG"} 接続先・ポート・タイムアウト・サイズ上限設定`);
    console.log(`${report.model.ready ? "OK" : "NG"} ${config.model}: ${report.guidance}`);
    console.log(`OS: ${report.host.os} ${report.host.arch} / RAM: ${(report.host.ram_total_bytes / 2 ** 30).toFixed(1)} GiB / Ollama: ${report.ollama_version ?? "未確認"}`);
    console.log(report.limits);
    console.log("問い合わせ用JSON: node --env-file=.env server.mjs doctor --json");
  }
  return nodeOk && report.configuration.auth_configured && report.configuration.valid && report.model.ready ? 0 : 1;
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0] ?? "serve";
  if (command === "doctor") {
    if (args.slice(1).some(arg => arg !== "--json")) throw new Error("doctor のオプションは --json のみです。");
    return runDoctor({}, fetch, args.includes("--json"));
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
  try {
    const exitCode = await main();
    if (exitCode !== 0) process.exitCode = exitCode;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
