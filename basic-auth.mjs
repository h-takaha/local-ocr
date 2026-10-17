import { createHash, timingSafeEqual } from "node:crypto";

function secureEqual(actual, expected) {
  const actualHash = createHash("sha256").update(actual, "utf8").digest();
  const expectedHash = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function decodeCredentials(authorization) {
  if (!authorization.startsWith("Basic ")) {
    return ["", ""];
  }
  const encoded = authorization.slice(6);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return ["", ""];
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64"));
    const separator = decoded.indexOf(":");
    return separator >= 0 ? [decoded.slice(0, separator), decoded.slice(separator + 1)] : ["", ""];
  } catch {
    return ["", ""];
  }
}

export function authorizeBasicRequest(request, response, realm, env = process.env) {
  let url;
  try { url = new URL(request.url ?? "/", "http://localhost"); }
  catch {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Bad Request");
    return false;
  }
  if (url.pathname === "/healthz") {
    return true;
  }

  const expectedPassword = env.BASIC_AUTH_PASSWORD ?? "";
  const expectedUsername = env.BASIC_AUTH_USER || "admin";
  const [providedUsername, providedPassword] = decodeCredentials(
    request.headers.authorization ?? "",
  );
  const usernameMatches = secureEqual(providedUsername, expectedUsername);
  const passwordMatches = secureEqual(providedPassword, expectedPassword);
  if (expectedPassword && usernameMatches && passwordMatches) {
    return true;
  }

  response.writeHead(401, {
    "Content-Type": "text/plain; charset=utf-8",
    "WWW-Authenticate": `Basic realm="${realm}"`,
  });
  response.end("Unauthorized");
  return false;
}
