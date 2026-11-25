// Cloudflare Worker용 Google 서비스 계정 인증. google-auth-library 대신 WebCrypto로 RS256 JWT를 서명해
// OAuth 2.0 JWT bearer 방식으로 access token을 받는다. Node API를 쓰지 않으며 다른 모듈에 의존하지 않는다.
// https://developers.google.com/identity/protocols/oauth2/service-account#httprest

export interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const TOKEN_LIFETIME_SECONDS = 3600;
const REQUEST_TIMEOUT_MS = 15_000;

/** 서비스 계정 JSON 키 파일 내용을 그대로 받아 검증한다. 오류 메시지에 키 내용을 넣지 않는다. */
export function parseServiceAccount(raw: string): GoogleServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("서비스 계정 JSON을 해석하지 못했습니다.");
  }
  const account = (parsed ?? {}) as Record<string, unknown>;
  if (account.type !== undefined && account.type !== "service_account") {
    throw new Error("서비스 계정 키(type: service_account)가 아닙니다.");
  }
  if (typeof account.client_email !== "string" || !account.client_email.includes("@")) {
    throw new Error("서비스 계정 JSON에 client_email이 없습니다.");
  }
  if (typeof account.private_key !== "string" || !account.private_key.includes("PRIVATE KEY")) {
    throw new Error("서비스 계정 JSON에 private_key가 없습니다.");
  }
  // 위조된 키가 token_uri를 바꿔 서명된 JWT를 다른 곳으로 보내지 않게, Google 토큰 엔드포인트만 허용한다.
  if (account.token_uri !== undefined && account.token_uri !== DEFAULT_TOKEN_URI) {
    throw new Error("서비스 계정 JSON의 token_uri가 Google 토큰 엔드포인트가 아닙니다.");
  }
  return { client_email: account.client_email, private_key: account.private_key, token_uri: DEFAULT_TOKEN_URI };
}

/** 서명된 JWT assertion을 만든다. 테스트에서 서명을 검증할 수 있게 따로 내보낸다. */
export async function signServiceAccountJwt(
  account: GoogleServiceAccount, scope: string, nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const unsigned = `${base64UrlJson({ alg: "RS256", typ: "JWT" })}.${base64UrlJson({
    iss: account.client_email,
    scope,
    aud: account.token_uri ?? DEFAULT_TOKEN_URI,
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_LIFETIME_SECONDS,
  })}`;
  const pem = account.private_key
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\\n|\s/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

/** 서비스 계정으로 access token을 받는다. 토큰은 1시간 유효하며, 실행마다 새로 받는 용도로 쓴다. */
export async function googleAccessToken(
  account: GoogleServiceAccount, scope: string, fetcher: typeof fetch = fetch,
): Promise<string> {
  const assertion = await signServiceAccountJwt(account, scope);
  const response = await fetcher(account.token_uri ?? DEFAULT_TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    // 응답 본문의 error 코드(invalid_grant 등)만 남긴다. 본문 전체는 로그에 남기지 않는다.
    const code = await response.json().then((body) => (body as { error?: unknown }).error, () => undefined);
    throw new Error(`Google 토큰 발급 실패: HTTP ${response.status}${typeof code === "string" ? ` ${code}` : ""}`);
  }
  const body = await response.json() as { access_token?: unknown };
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new Error("Google 토큰 응답에 access_token이 없습니다.");
  }
  return body.access_token;
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
