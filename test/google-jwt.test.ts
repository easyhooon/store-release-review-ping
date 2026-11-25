import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { googleAccessToken, parseServiceAccount, signServiceAccountJwt } from "../src/google-jwt.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyJson = JSON.stringify({
  type: "service_account",
  client_email: "ping@example.iam.gserviceaccount.com",
  private_key: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  token_uri: "https://oauth2.googleapis.com/token",
});

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

test("RS256으로 서명한 JWT는 공개키로 검증되고 Google이 요구하는 클레임을 담는다", async () => {
  const jwt = await signServiceAccountJwt(parseServiceAccount(keyJson), "https://www.googleapis.com/auth/androidpublisher", 1_000);
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(decode(payload), {
    iss: "ping@example.iam.gserviceaccount.com",
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: "https://oauth2.googleapis.com/token",
    iat: 1_000,
    exp: 4_600,
  });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, "base64url")), true);
});

test("JWT bearer 방식으로 토큰을 요청하고 access_token을 돌려준다", async () => {
  let captured: { url: string; body: URLSearchParams } | undefined;
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    captured = { url: String(input), body: new URLSearchParams(String(init?.body)) };
    return Response.json({ access_token: "ya29.test", expires_in: 3599 });
  }) as typeof fetch;
  assert.equal(await googleAccessToken(parseServiceAccount(keyJson), "scope-x", fetcher), "ya29.test");
  assert.equal(captured?.url, "https://oauth2.googleapis.com/token");
  assert.equal(captured?.body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  assert.equal(captured?.body.get("assertion")?.split(".").length, 3);
});

test("토큰 발급 실패는 오류 코드만 담아 던진다", async () => {
  const fetcher = (async () => Response.json({ error: "invalid_grant", error_description: "secret detail" }, { status: 400 })) as typeof fetch;
  await assert.rejects(googleAccessToken(parseServiceAccount(keyJson), "s", fetcher), (error: Error) => {
    assert.equal(error.message, "Google 토큰 발급 실패: HTTP 400 invalid_grant");
    return true;
  });
});

test("서비스 계정 JSON이 아니거나 token_uri가 Google이 아니면 거부한다", () => {
  assert.throws(() => parseServiceAccount("not json"), /해석하지 못했습니다/);
  assert.throws(() => parseServiceAccount(JSON.stringify({ client_email: "a@b" })), /private_key/);
  assert.throws(() => parseServiceAccount(JSON.stringify({ ...JSON.parse(keyJson), token_uri: "https://evil.example/token" })),
    /token_uri/);
  assert.throws(() => parseServiceAccount(JSON.stringify({ ...JSON.parse(keyJson), type: "authorized_user" })),
    /service_account/);
});
