// Cloudflare Worker용 App Store Connect JWT. node:crypto 대신 WebCrypto로 서명한다.

export interface AppleWorkerKey {
  /** "team"(기본값) 또는 "individual". 개인 키는 Issuer ID 없이 서명한다. */
  APP_STORE_CONNECT_KEY_TYPE?: string;
  APP_STORE_CONNECT_KEY_ID: string;
  APP_STORE_CONNECT_ISSUER_ID?: string;
  APP_STORE_CONNECT_PRIVATE_KEY: string;
}

export function validWorkerKeyConfig(env: AppleWorkerKey): boolean {
  const type = env.APP_STORE_CONNECT_KEY_TYPE ?? "team";
  if (!env.APP_STORE_CONNECT_KEY_ID || !env.APP_STORE_CONNECT_PRIVATE_KEY) return false;
  if (type === "individual") return true;
  return type === "team" && !!env.APP_STORE_CONNECT_ISSUER_ID;
}

export async function appleWorkerToken(env: AppleWorkerKey): Promise<string> {
  const encode = (value: unknown) => btoa(JSON.stringify(value))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const issued = Math.floor(Date.now() / 1000);
  // 팀 키는 iss(Issuer ID), 개인 키는 sub: "user"로 서명한다.
  const subject = env.APP_STORE_CONNECT_KEY_TYPE === "individual"
    ? { sub: "user" } : { iss: env.APP_STORE_CONNECT_ISSUER_ID };
  const unsigned = `${encode({ alg: "ES256", kid: env.APP_STORE_CONNECT_KEY_ID, typ: "JWT" })}.${encode({
    ...subject, iat: issued, exp: issued + 1200, aud: "appstoreconnect-v1",
  })}`;
  const pem = env.APP_STORE_CONNECT_PRIVATE_KEY.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const bytes = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", bytes, { name: "ECDSA", namedCurve: "P-256" },
    false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned),
  ));
  const encoded = btoa(String.fromCharCode(...signature)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${unsigned}.${encoded}`;
}
