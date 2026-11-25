// App Store Connect 웹훅의 x-apple-signature(원문 본문 HMAC-SHA256)를 상수 시간으로 비교한다.

export async function validSignature(body: ArrayBuffer, header: string | null, secret: string): Promise<boolean> {
  const match = /^hmacsha256=([a-fA-F0-9]{64})$/.exec(header ?? "");
  if (!match) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  const supplied = Uint8Array.from(match[1]!.match(/../g)!, (pair) => Number.parseInt(pair, 16));
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected[i]! ^ supplied[i]!;
  return difference === 0;
}
