import { platform, release, arch, totalmem, freemem, cpus } from "node:os";

export function validateConfig(config) {
  let endpoint;
  try { endpoint = new URL(config.ollamaBaseUrl); } catch { return false; }
  return ["http:", "https:"].includes(endpoint.protocol) &&
    !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash &&
    Number.isInteger(config.port) && config.port >= 1 && config.port <= 65535 &&
    Number.isInteger(config.timeoutMs) && config.timeoutMs >= 1 && config.timeoutMs <= 2147483647 &&
    [config.maxImageBytes, config.maxRequestBytes].every(value => Number.isSafeInteger(value) && value > 0);
}

export async function ollamaJson(config, path, fetchImpl = fetch, body) {
  const response = await fetchImpl(`${config.ollamaBaseUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(3000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("ollama_api_failed");
  return response.json();
}

export function isLocalModel(model) {
  return !model.remote_host && !model.remote_model && !/(?:[:\-]cloud)$/.test(model.name ?? model.model ?? "");
}

export async function inspectModel(config, fetchImpl = fetch) {
  try {
    const tags = await ollamaJson(config, "/api/tags", fetchImpl);
    if (!Array.isArray(tags.models)) throw new Error("invalid_tags");
    const model = tags.models.find(m => m.name === config.model || m.model === config.model);
    if (!model) return { ready: false, ollama: true, modelInstalled: false, code: "model_missing" };
    if (!isLocalModel(model)) return { ready: false, ollama: true, modelInstalled: true, code: "cloud_model_blocked" };
    let info;
    try { info = await ollamaJson(config, "/api/show", fetchImpl, { model: config.model }); } catch { /* Unknown, not compatible by inference. */ }
    const local = info ? isLocalModel(info) : null;
    const vision = Array.isArray(info?.capabilities) ? info.capabilities.includes("vision") : null;
    const code = local === false ? "cloud_model_blocked" : vision === false ? "vision_unsupported" : local === null || vision === null ? "model_unverified" : "ready";
    return { ready: code === "ready", ollama: true, modelInstalled: true, code,
      vision, local, size_bytes: Number.isFinite(model.size) ? model.size : null,
      quantization: /^(?:Q|IQ|F|BF)[A-Z0-9_]{1,20}$/.test(model.details?.quantization_level ?? "") ? model.details.quantization_level : null };
  } catch {
    return { ready: false, ollama: false, modelInstalled: null, code: "ollama_unavailable" };
  }
}

export const GUIDANCE = {
  ready: "接続・ローカル画像対応モデルを確認しました。OCRの成否と速度はサンプルで確認してください。",
  model_missing: "指定モデルがありません。READMEのモデル導入手順を確認し、導入後に再確認してください。",
  cloud_model_blocked: "クラウドモデルは使用できません。ローカルの画像対応モデルを明示して再起動してください。",
  vision_unsupported: "画像非対応のモデルです。ローカルの画像対応モデルを明示して再起動してください。",
  model_unverified: "モデルの画像対応・ローカル実行を確認できません。Ollamaのバージョンと接続先の /api/show 対応を確認してください。",
  ollama_unavailable: "Ollamaに接続できません。Ollamaを起動し、このアプリの接続先設定を確認してください。",
};

export async function collectDiagnostics(config, fetchImpl = fetch, env = process.env) {
  const model = await inspectModel(config, fetchImpl);
  const safeNumber = value => Number.isFinite(value) && value >= 0 ? value : null;
  let version = null;
  let placement = null;
  const extras = await Promise.allSettled([
    ollamaJson(config, "/api/version", fetchImpl),
    ollamaJson(config, "/api/ps", fetchImpl),
  ]);
  if (extras[0].status === "fulfilled" && typeof extras[0].value.version === "string") {
    version = /^(\d{1,5}\.\d{1,5}\.\d{1,5})(?:[-+].*)?$/.exec(extras[0].value.version)?.[1] ?? null;
  }
  if (extras[1].status === "fulfilled" && Array.isArray(extras[1].value.models)) {
    const loaded = extras[1].value.models.find(m => m.name === config.model || m.model === config.model);
    placement = loaded ? { loaded: true, size_bytes: safeNumber(loaded.size), vram_bytes: safeNumber(loaded.size_vram) } : { loaded: false };
  }
  let url;
  try { url = new URL(config.ollamaBaseUrl); } catch { /* Config validation handles startup. */ }
  return {
    schema_version: 1,
    checked_at: new Date().toISOString(),
    host: { os: platform(), release: release(), arch: arch(), node: process.version,
      logical_cpus: cpus().length, ram_total_bytes: totalmem(), ram_available_bytes: freemem() },
    configuration: { model: config.model, timeout_ms: config.timeoutMs,
      connection: url && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ? "loopback" : "custom",
      auth_configured: Boolean(env.BASIC_AUTH_PASSWORD), valid: validateConfig(config) },
    ollama_version: version, model, placement,
    guidance: GUIDANCE[model.code],
    limits: "RAMはWebサーバー側の値です。GPU型番・ドライバー・空きVRAM・ディスク空き・快適性は未確認。モデル保存サイズは必要RAM/VRAMではありません。配置は取得時点のみ。OCR成功・品質はサンプルの結果と原文で別途確認してください。",
  };
}
