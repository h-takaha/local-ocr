import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  OCR_PROMPT,
  buildOllamaPayload,
  createHandler,
  decodeImageData,
  getConfig,
} from "../server.mjs";

import {
  calculateOutputSize,
  enhanceRgbaForOcr,
} from "../static/image-processing.mjs";

const JPEG_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]);
const JPEG_DATA_URL = `data:image/jpeg;base64,${JPEG_BUFFER.toString("base64")}`;
const AUTH_ENV = { BASIC_AUTH_PASSWORD: "secret" };
const AUTHORIZATION = `Basic ${Buffer.from("admin:secret").toString("base64")}`;

test("PWA assets have valid dimensions and retain Basic authentication", async () => {
  await withServer(createHandler({ env: AUTH_ENV }), async (baseUrl) => {
    const manifestPath = "/static/manifest.webmanifest";
    for (const path of ["/", manifestPath, "/static/pwa-icon-192.png", "/static/pwa-icon-512.png", "/api/ocr"]) {
      assert.equal((await fetch(`${baseUrl}${path}`)).status, 401);
    }
    const html = await (await fetchAuth(baseUrl)).text();
    assert.match(html, /href="\/static\/manifest\.webmanifest" crossorigin="use-credentials"/);
    const response = await fetchAuth(`${baseUrl}${manifestPath}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/manifest+json");
    const manifest = await response.json();
    for (const field of ["id", "start_url", "scope"]) assert.equal(manifest[field], "/");
    assert.equal(manifest.display, "standalone");
    assert.deepEqual(manifest.icons.map(icon => icon.sizes), ["192x192", "512x512"]);
    for (const icon of manifest.icons) {
      const response = await fetchAuth(`${baseUrl}${icon.src}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/png");
      const png = Buffer.from(await response.arrayBuffer());
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      const size = Number(icon.sizes.split("x")[0]);
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
    }
    assert.equal((await fetchAuth(`${baseUrl}/static/../server.mjs`)).status, 404);
  });
  await withServer(createHandler({ env: {} }), async baseUrl => {
    assert.equal((await fetchAuth(`${baseUrl}/static/manifest.webmanifest`)).status, 401);
  });
});

function fetchAuth(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { Authorization: AUTHORIZATION, ...(options.headers ?? {}) },
  });
}

test("qwen3.5:9b is the default OCR model", () => {
  assert.equal(getConfig().model, "qwen3.5:9b");
});

test("the dispatcher URL takes precedence over the legacy Ollama URL", (t) => {
  const previousDispatcherUrl = process.env.LOCAL_LLM_DISPATCHER_URL;
  const previousOllamaUrl = process.env.OLLAMA_BASE_URL;
  t.after(() => {
    if (previousDispatcherUrl === undefined) delete process.env.LOCAL_LLM_DISPATCHER_URL;
    else process.env.LOCAL_LLM_DISPATCHER_URL = previousDispatcherUrl;
    if (previousOllamaUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previousOllamaUrl;
  });
  process.env.LOCAL_LLM_DISPATCHER_URL = "http://127.0.0.1:11435";
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
  assert.equal(getConfig().ollamaBaseUrl, "http://127.0.0.1:11435");
});

test("high accuracy mode enlarges small images without exceeding limits", () => {
  assert.deepEqual(calculateOutputSize(4000, 2000), {
    width: 3000,
    height: 1500,
  });
  assert.deepEqual(calculateOutputSize(446, 591), {
    width: 446,
    height: 591,
  });
  assert.deepEqual(calculateOutputSize(446, 591, true), {
    width: 1338,
    height: 1773,
  });
});

test("high accuracy enhancement creates grayscale contrast and opaque pixels", () => {
  const rgba = new Uint8ClampedArray([
    50, 50, 50, 20,
    100, 100, 100, 40,
    150, 150, 150, 60,
    200, 200, 200, 80,
  ]);
  const result = enhanceRgbaForOcr(rgba, 2, 2);

  assert.equal(result, rgba);
  assert.equal(result[0], 0);
  assert.equal(result[12], 255);
  for (let offset = 0; offset < result.length; offset += 4) {
    assert.equal(result[offset], result[offset + 1]);
    assert.equal(result[offset], result[offset + 2]);
    assert.equal(result[offset + 3], 255);
  }
});

test("high accuracy enhancement preserves a flat grayscale image", () => {
  const rgba = new Uint8ClampedArray([120, 120, 120, 255]);
  enhanceRgbaForOcr(rgba, 1, 1);
  assert.deepEqual([...rgba], [120, 120, 120, 255]);
});

async function withServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("decodeImageData accepts a signed JPEG data URL", () => {
  const image = decodeImageData(JPEG_DATA_URL);
  assert.equal(image.mimeType, "image/jpeg");
  assert.deepEqual(image.buffer, JPEG_BUFFER);
});

test("decodeImageData rejects a mismatched signature", () => {
  const invalid = `data:image/png;base64,${JPEG_BUFFER.toString("base64")}`;
  assert.throws(
    () => decodeImageData(invalid),
    (error) => error.status === 400 && error.code === "invalid_image",
  );
});

test("decodeImageData enforces decoded image size", () => {
  assert.throws(
    () => decodeImageData(JPEG_DATA_URL, 3),
    (error) => error.status === 413 && error.code === "image_too_large",
  );
});

test("buildOllamaPayload disables thinking and sends OCR-only prompt", () => {
  const payload = buildOllamaPayload(JPEG_BUFFER, "qwen3.5:9b");
  assert.equal(payload.model, "qwen3.5:9b");
  assert.equal(payload.think, false);
  assert.equal(payload.stream, false);
  assert.equal(payload.options.num_ctx, 8192);
  assert.equal(payload.options.temperature, 0);
  assert.match(payload.prompt, /要約、説明、翻訳、推測、補完をしない/);
  assert.equal(payload.prompt, OCR_PROMPT);
  assert.deepEqual(payload.images, [JPEG_BUFFER.toString("base64")]);
});

test("POST /api/ocr returns local model output without retaining the image", async () => {
  let receivedPayload;
  let receivedHeaders;
  const mockFetch = async (_url, options) => {
    receivedPayload = JSON.parse(options.body);
    receivedHeaders = options.headers;
    return new Response(JSON.stringify({ response: "北海道\n浦河町" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const logs = [];
  const handler = createHandler({
    fetchImpl: mockFetch,
    env: AUTH_ENV,
    logger: { info: (line) => logs.push(line), error: (line) => logs.push(line) },
  });

  await withServer(handler, async (baseUrl) => {
    const response = await fetchAuth(`${baseUrl}/api/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: JPEG_DATA_URL, width: 1, height: 1 }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.text, "北海道\n浦河町");
    assert.equal(payload.model, "qwen3.5:9b");
    assert.equal(typeof payload.elapsed_ms, "number");
  });

  assert.equal(receivedPayload.images[0], JPEG_BUFFER.toString("base64"));
  assert.equal(receivedHeaders["X-LLM-Priority"], "critical");
  assert.equal(logs.some((line) => line.includes(JPEG_DATA_URL)), false);
  assert.equal(logs.some((line) => line.includes("北海道")), false);
});

test("POST /api/ocr returns 429 while another image is processing", async () => {
  const handler = createHandler({ state: { busy: true }, env: AUTH_ENV });
  await withServer(handler, async (baseUrl) => {
    const response = await fetchAuth(`${baseUrl}/api/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: JPEG_DATA_URL }),
    });
    assert.equal(response.status, 429);
    const payload = await response.json();
    assert.equal(payload.code, "ocr_busy");
  });
});

test("POST /api/ocr reports Ollama connection failures safely", async () => {
  const handler = createHandler({
    fetchImpl: async () => {
      throw new TypeError("connection refused");
    },
    logger: { info() {}, error() {} },
    env: AUTH_ENV,
  });
  await withServer(handler, async (baseUrl) => {
    const response = await fetchAuth(`${baseUrl}/api/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: JPEG_DATA_URL }),
    });
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.code, "ollama_unavailable");
    assert.equal(payload.error.includes("Ollama"), true);
  });
});

test("health endpoints separate process liveness from model readiness", async () => {
  const mockFetch = async () =>
    new Response(
      JSON.stringify({ models: [{ name: "qwen3.5:9b", model: "qwen3.5:9b" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  const handler = createHandler({ fetchImpl: mockFetch, env: AUTH_ENV });
  await withServer(handler, async (baseUrl) => {
    const liveResponse = await fetchAuth(`${baseUrl}/health`);
    assert.equal(liveResponse.status, 200);
    assert.equal((await liveResponse.json()).service, "local_ocr");

    const readyResponse = await fetchAuth(`${baseUrl}/api/health`);
    assert.equal(readyResponse.status, 200);
    const readyPayload = await readyResponse.json();
    assert.equal(readyPayload.status, "ready");
    assert.equal(readyPayload.model_installed, true);
  });
});

test("web UI serves the high accuracy controls and image module", async () => {
  const handler = createHandler({ env: AUTH_ENV });
  await withServer(handler, async (baseUrl) => {
    const pageResponse = await fetchAuth(`${baseUrl}/`);
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.text();
    assert.match(page, /name="processing-mode" value="normal" checked/);
    assert.match(page, /name="processing-mode" value="high"/);
    assert.match(page, /type="module"/);

    const moduleResponse = await fetchAuth(`${baseUrl}/image-processing.mjs`);
    assert.equal(moduleResponse.status, 200);
    assert.match(
      moduleResponse.headers.get("content-type"),
      /^text\/javascript; charset=utf-8$/,
    );
    assert.match(await moduleResponse.text(), /export function enhanceRgbaForOcr/);
  });
});

test("Basic auth is fail-closed except for /healthz", async () => {
  const handler = createHandler({ env: {} });
  await withServer(handler, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);

    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), 'Basic realm="Local OCR"');
  });
});

test("Basic auth accepts only the configured credentials and preserves handler status", async () => {
  const handler = createHandler({ env: AUTH_ENV });
  await withServer(handler, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/`)).status, 401);
    assert.equal(
      (await fetch(`${baseUrl}/`, { headers: { Authorization: `Basic ${Buffer.from("wrong:secret").toString("base64")}` } })).status,
      401,
    );
    assert.equal(
      (await fetch(`${baseUrl}/`, { headers: { Authorization: `Basic ${Buffer.from("admin:wrong").toString("base64")}` } })).status,
      401,
    );
    assert.equal((await fetchAuth(`${baseUrl}/`)).status, 200);
    assert.equal((await fetchAuth(`${baseUrl}/missing`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
  });
});
