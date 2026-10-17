import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import test from "node:test";

import {
  OCR_PROMPT,
  buildOllamaPayload,
  callOllama,
  createHandler,
  decodeImageData,
  getConfig,
  runDoctor,
  startServer,
} from "../server.mjs";
import { collectDiagnostics } from "../diagnostics.mjs";

import {
  calculateOutputSize,
  enhanceRgbaForOcr,
} from "../static/image-processing.mjs";

const JPEG_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]);
const JPEG_DATA_URL = `data:image/jpeg;base64,${JPEG_BUFFER.toString("base64")}`;
const AUTH_ENV = { BASIC_AUTH_PASSWORD: "secret" };
const AUTHORIZATION = `Basic ${Buffer.from("admin:secret").toString("base64")}`;

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createOllamaMock(routes = {}, calls = []) {
  const responses = {
    "/api/tags": { models: [{ name: "qwen3.5:9b", size: 6_600_000_000, details: { quantization_level: "Q4_K_M" } }] },
    "/api/show": { capabilities: ["completion", "vision"] },
    "/api/generate": { response: "北海道\n浦河町", done: true, load_duration: 12_500_000 },
    "/api/version": { version: "0.12.0" },
    "/api/ps": { models: [] },
    ...routes,
  };
  return async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ url, path, options });
    assert.ok(Object.hasOwn(responses, path), `Unexpected Ollama path: ${path}`);
    const result = responses[path];
    return typeof result === "function" ? result(url, options) : jsonResponse(result);
  };
}

function postOcr(baseUrl) {
  return fetchAuth(`${baseUrl}/api/ocr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: JPEG_DATA_URL }),
  });
}

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
  const calls = [];
  const mockFetch = createOllamaMock({ "/api/generate": async (_url, options) => {
    receivedPayload = JSON.parse(options.body);
    receivedHeaders = options.headers;
    return jsonResponse({ response: "北海道\n浦河町", done: true, load_duration: 12_500_000 });
  } }, calls);
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
    assert.equal(payload.load_ms, 13);
  });

  assert.deepEqual(calls.map(call => call.path), ["/api/tags", "/api/show", "/api/generate"]);
  assert.deepEqual(JSON.parse(calls[1].options.body), { model: "qwen3.5:9b" });
  assert.equal(calls.every(call => call.options.redirect === "error"), true);
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
  const mockFetch = createOllamaMock();
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
    assert.equal(readyPayload.code, "ready");
    assert.equal(typeof readyPayload.guidance, "string");
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

test("OCR never sends an image when model safety or vision support is unverified", async (t) => {
  const cases = [
    { name: "missing model", routes: { "/api/tags": { models: [{ name: "another-local:latest" }] } }, code: "model_missing", installed: false },
    { name: "text-only model", routes: { "/api/show": { capabilities: ["completion"] } }, code: "vision_unsupported", installed: true },
    { name: "unknown capabilities", routes: { "/api/show": {} }, code: "model_unverified", installed: true },
    { name: "show endpoint unavailable", routes: { "/api/show": () => jsonResponse({ error: "not supported" }, 404) }, code: "model_unverified", installed: true },
    { name: "cloud host in tags", routes: { "/api/tags": { models: [{ name: "qwen3.5:9b", remote_host: "https://cloud.example" }] } }, code: "cloud_model_blocked", installed: true },
    { name: "remote model in tags", routes: { "/api/tags": { models: [{ name: "qwen3.5:9b", remote_model: "remote:9b" }] } }, code: "cloud_model_blocked", installed: true },
    { name: "cloud host in show", routes: { "/api/show": { capabilities: ["vision"], remote_host: "https://cloud.example" } }, code: "cloud_model_blocked", installed: true },
    { name: "remote model in show", routes: { "/api/show": { capabilities: ["vision"], remote_model: "remote:9b" } }, code: "cloud_model_blocked", installed: true },
    { name: "malformed tags", routes: { "/api/tags": { models: null } }, code: "ollama_unavailable", installed: null },
    { name: "unreachable Ollama", routes: { "/api/tags": () => { throw new TypeError("private host unreachable"); } }, code: "ollama_unavailable", installed: null },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const calls = [];
      const state = { busy: false };
      const handler = createHandler({ fetchImpl: createOllamaMock(item.routes, calls), env: AUTH_ENV, state, logger: {} });
      await withServer(handler, async baseUrl => {
        const health = await fetchAuth(`${baseUrl}/api/health`);
        assert.equal(health.status, 503);
        const healthBody = await health.json();
        assert.equal(healthBody.code, item.code);
        assert.equal(healthBody.model_installed, item.installed);
        assert.equal(typeof healthBody.guidance, "string");
        const response = await postOcr(baseUrl);
        assert.equal(response.status, 503);
        assert.equal((await response.json()).code, item.code);
      });
      assert.equal(state.busy, false);
      assert.equal(calls.some(call => call.path === "/api/generate"), false);
      assert.equal(calls.every(call => !call.options.body?.includes(JPEG_BUFFER.toString("base64"))), true);
    });
  }
});

test("cloud-suffixed models are blocked without showing or generating them", async (t) => {
  for (const model of ["qwen3.5:cloud", "qwen3.5-cloud"]) {
    await t.test(model, async () => {
      const calls = [];
      const handler = createHandler({
        config: { model }, env: AUTH_ENV, logger: {},
        fetchImpl: createOllamaMock({ "/api/tags": { models: [{ name: model }] } }, calls),
      });
      await withServer(handler, async baseUrl => {
        const response = await postOcr(baseUrl);
        assert.equal(response.status, 503);
        assert.equal((await response.json()).code, "cloud_model_blocked");
      });
      assert.deepEqual(calls.map(call => call.path), ["/api/tags"]);
    });
  }
});

test("OCR uses only the explicitly configured model and never switches models", async () => {
  const model = "custom-local:7b";
  const calls = [];
  const handler = createHandler({
    config: { model, ollamaBaseUrl: "http://127.0.0.1:11434" }, env: AUTH_ENV, logger: {},
    fetchImpl: createOllamaMock({ "/api/tags": { models: [{ name: "qwen3.5:9b" }, { model }] } }, calls),
  });
  await withServer(handler, async baseUrl => {
    const response = await postOcr(baseUrl);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).model, model);
  });
  assert.deepEqual(calls.map(call => call.path), ["/api/tags", "/api/show", "/api/generate"]);
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, "http://127.0.0.1:11434");
    if (call.options.body) assert.equal(JSON.parse(call.options.body).model, model);
  }
});

test("callOllama rejects incomplete, empty, and invalid output", async (t) => {
  const cases = [
    [{ response: "partial", done: false }, "incomplete_ocr_result"],
    [{ response: "partial", done: true, done_reason: "length" }, "incomplete_ocr_result"],
    [{ response: "  \n\t", done: true }, "empty_ocr_result"],
    [{ done: true }, "empty_ocr_result"],
  ];
  for (const [payload, code] of cases) {
    await t.test(code + JSON.stringify(payload), async () => {
      await assert.rejects(callOllama(JPEG_BUFFER, getConfig(), async () => jsonResponse(payload)), error => error.status === 502 && error.code === code);
    });
  }
  await assert.rejects(callOllama(JPEG_BUFFER, getConfig(), async () => new Response("private invalid data")), error => error.status === 502 && error.code === "invalid_ollama_response" && !error.message.includes("private"));
});

test("callOllama reports load time only when Ollama supplied a valid duration", async (t) => {
  for (const duration of [undefined, -1, "1000000", null]) {
    await t.test(String(duration), async () => {
      assert.deepEqual(await callOllama(JPEG_BUFFER, getConfig(), async () => jsonResponse({ response: " text ", load_duration: duration })), { text: "text", load_ms: null });
    });
  }
});

test("upstream errors are classified without returning or logging their private body", async (t) => {
  const privateText = "PRIVATE-OCR-TEXT C:\\Users\\PrivateUser\\scan.png private-host secret-token";
  const cases = [
    [500, "out of memory", "ollama_memory", 503],
    [500, "model requires more system memory", "ollama_memory", 503],
    [500, "not enough memory", "ollama_memory", 503],
    [500, "failed to allocate buffer", "ollama_memory", 503],
    [404, "model custom not found", "model_missing", 503],
    [503, "runner startup failed", "ollama_busy", 503],
    [500, "unexpected internal failure", "ollama_error", 502],
    [404, "unknown route", "ollama_error", 502],
  ];
  for (const [upstreamStatus, detail, code, expectedStatus] of cases) {
    await t.test(detail, async () => {
      const logs = [];
      const state = { busy: false };
      const handler = createHandler({
        env: AUTH_ENV, state,
        logger: { info: line => logs.push(line), error: line => logs.push(line) },
        fetchImpl: createOllamaMock({ "/api/generate": () => jsonResponse({ error: `${detail}: ${privateText}` }, upstreamStatus) }),
      });
      await withServer(handler, async baseUrl => {
        const response = await postOcr(baseUrl);
        assert.equal(response.status, expectedStatus);
        const body = await response.json();
        assert.equal(body.code, code);
        assert.equal(JSON.stringify(body).includes(privateText), false);
        assert.equal(JSON.stringify(body).includes(detail), false);
      });
      assert.equal(state.busy, false);
      assert.deepEqual(logs, [`[local_ocr] error code=${code}`]);
    });
  }
});

test("Ollama timeouts cover both response headers and response body", async (t) => {
  for (const phase of ["headers", "body"]) {
    await t.test(phase, async () => {
      await withServer((_request, response) => {
        if (phase === "body") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.flushHeaders();
          response.write('{"response":"');
        }
        setTimeout(() => response.end(phase === "body" ? 'text"}' : '{"response":"text"}'), 150);
      }, async ollamaBaseUrl => {
        await assert.rejects(callOllama(JPEG_BUFFER, getConfig({ ollamaBaseUrl, timeoutMs: 30 })), error => error.status === 504 && error.code === "ollama_timeout");
      });
    });
  }
});

test("diagnostics is authenticated and never contacts Ollama before authentication", async () => {
  const calls = [];
  const handler = createHandler({ env: AUTH_ENV, fetchImpl: createOllamaMock({}, calls) });
  await withServer(handler, async baseUrl => {
    assert.equal((await fetch(`${baseUrl}/api/diagnostics`)).status, 401);
    assert.deepEqual(calls, []);
    const response = await fetchAuth(`${baseUrl}/api/diagnostics`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).model.ready, true);
  });
});

test("diagnostic JSON contains only allowed fields and excludes upstream private metadata", async () => {
  const secret = "PRIVATE-CONTENT-C:\\Users\\Somebody-secret-host-token";
  const report = await collectDiagnostics(getConfig({ ollamaBaseUrl: "http://user:password@private-host:11434" }), createOllamaMock({
    "/api/tags": { models: [{ name: "qwen3.5:9b", size: 1234, details: { quantization_level: "Q4_K_M", private: secret }, digest: secret, path: secret }] },
    "/api/show": { capabilities: ["vision"], modelfile: secret, template: secret, parameters: secret, system: secret, license: secret },
    "/api/ps": { models: [{ name: "qwen3.5:9b", size: 4321, size_vram: 123, path: secret, prompt: secret }] },
    "/api/version": { version: "0.12.0", hostname: secret },
  }), { BASIC_AUTH_USER: secret, BASIC_AUTH_PASSWORD: secret });
  const keys = object => Object.keys(object).sort();
  assert.deepEqual(keys(report), ["schema_version", "checked_at", "host", "configuration", "ollama_version", "model", "placement", "guidance", "limits"].sort());
  assert.deepEqual(keys(report.host), ["os", "release", "arch", "node", "logical_cpus", "ram_total_bytes", "ram_available_bytes"].sort());
  assert.deepEqual(keys(report.configuration), ["model", "timeout_ms", "connection", "auth_configured", "valid"].sort());
  assert.deepEqual(keys(report.model), ["ready", "ollama", "modelInstalled", "code", "vision", "local", "size_bytes", "quantization"].sort());
  assert.deepEqual(keys(report.placement), ["loaded", "size_bytes", "vram_bytes"].sort());
  assert.equal(report.configuration.connection, "custom");
  assert.equal(report.configuration.auth_configured, true);
  assert.equal(report.configuration.valid, false);
  assert.equal(report.ollama_version, "0.12.0");
  assert.equal(report.model.size_bytes, 1234);
  assert.equal(report.model.vision, true);
  assert.equal(report.model.local, true);
  assert.equal(report.model.quantization, "Q4_K_M");
  assert.deepEqual(report.placement, { loaded: true, size_bytes: 4321, vram_bytes: 123 });
  assert.equal(Number.isFinite(Date.parse(report.checked_at)), true);
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.doesNotMatch(JSON.stringify(report), /private-host|private-path|password|token=secret/);
});

test("diagnostics uses null for unavailable optional version and placement measurements", async () => {
  const report = await collectDiagnostics(getConfig(), createOllamaMock({
    "/api/version": () => { throw new Error("private path"); },
    "/api/ps": () => jsonResponse({ error: "private path" }, 500),
  }), {});
  assert.equal(report.model.ready, true);
  assert.equal(report.ollama_version, null);
  assert.equal(report.placement, null);
  assert.equal(report.configuration.auth_configured, false);
  const invalid = await collectDiagnostics(getConfig(), createOllamaMock({
    "/api/version": { version: "private-host/path" },
    "/api/ps": { models: [{ name: "qwen3.5:9b", size: -1, size_vram: "unknown" }] },
  }), {});
  assert.equal(invalid.ollama_version, null);
  assert.deepEqual(invalid.placement, { loaded: true, size_bytes: null, vram_bytes: null });
});

test("diagnostics rejects private freeform quantization metadata", async () => {
  const secret = "C:\\Users\\PrivateUser\\models-private-host-secret-token";
  const report = await collectDiagnostics(getConfig(), createOllamaMock({
    "/api/tags": { models: [{ name: "qwen3.5:9b", size: 1234, details: { quantization_level: secret } }] },
  }), AUTH_ENV);
  assert.equal(report.model.quantization, null);
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test("malformed HTTP request targets return 400 before authentication and leave the server alive", async () => {
  const calls = [];
  await withServer(createHandler({ env: AUTH_ENV, fetchImpl: createOllamaMock({}, calls) }), async baseUrl => {
    const response = await new Promise((resolve, reject) => {
      const socket = createConnection(Number(new URL(baseUrl).port), "127.0.0.1", () => {
        socket.write("GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
      });
      let received = "";
      socket.setTimeout(2000, () => socket.destroy(new Error("Malformed request did not receive a response")));
      socket.setEncoding("utf8");
      socket.on("data", chunk => { received += chunk; });
      socket.once("end", () => resolve(received));
      socket.once("error", reject);
    });
    assert.match(response, /^HTTP\/1\.1 400 /);
    assert.match(response, /Bad Request/);
    assert.deepEqual(calls, []);
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
  });
});

test("doctor fails and serve refuses invalid connection, port, timeout, and size limits", async t => {
  const previousPassword = process.env.BASIC_AUTH_PASSWORD;
  process.env.BASIC_AUTH_PASSWORD = "test-only";
  t.after(() => {
    if (previousPassword === undefined) delete process.env.BASIC_AUTH_PASSWORD;
    else process.env.BASIC_AUTH_PASSWORD = previousPassword;
  });
  const logs = [];
  t.mock.method(console, "log", line => logs.push(line));
  const cases = [
    ["port zero", { port: 0 }],
    ["port outside range", { port: 65536 }],
    ["timeout zero", { timeoutMs: 0 }],
    ["timeout outside range", { timeoutMs: 2147483648 }],
    ["NaN image limit", { maxImageBytes: NaN }],
    ["NaN request limit", { maxRequestBytes: NaN }],
    ["invalid connection URL", { ollamaBaseUrl: "http://[" }],
    ["credential-bearing connection", { ollamaBaseUrl: "http://user:secret@localhost:11434" }],
  ];
  const validConfig = getConfig({ ollamaBaseUrl: "http://127.0.0.1:11434", port: 8005, timeoutMs: 360000, maxImageBytes: 20 * 1024 * 1024, maxRequestBytes: 28 * 1024 * 1024 });
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const mockFetch = createOllamaMock();
      // Readiness alone is insufficient when the server would refuse its settings.
      assert.equal(await runDoctor({ ...validConfig, ...overrides }, mockFetch, true), 1);
      const report = JSON.parse(logs.at(-1));
      assert.equal(report.configuration.valid, false);
      assert.throws(() => startServer({ ...validConfig, ...overrides }), /設定が不正/);
    });
  }
  assert.equal(await runDoctor(validConfig, createOllamaMock(), true), Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1);
  assert.equal(JSON.parse(logs.at(-1)).configuration.valid, true);
});

test("diagnostics removes freeform suffixes from the reported Ollama version", async t => {
  for (const version of ["0.12.0-private-host-secret", "0.12.0+private-host-secret"]) {
    await t.test(version, async () => {
      const report = await collectDiagnostics(getConfig(), createOllamaMock({ "/api/version": { version } }), AUTH_ENV);
      assert.equal(report.ollama_version, "0.12.0");
      assert.equal(JSON.stringify(report).includes("private-host-secret"), false);
    });
  }
});
