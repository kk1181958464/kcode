import {
  createHash,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";
const USERNAME_PATTERN = /^[\p{L}\p{N}_.@-]{3,64}$/u;

function deriveKey(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, derived) => (error ? reject(error) : resolve(derived as Buffer)),
    );
  });
}

export function normalizeUsername(value: unknown) {
  if (typeof value !== "string") throw new Error("请输入账号");
  const username = value.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username))
    throw new Error(
      "账号需为 3-64 位，可使用文字、字母、数字、点、横线或下划线",
    );
  return username;
}

export function validatePassword(value: unknown) {
  if (typeof value !== "string" || value.length < 10 || value.length > 128)
    throw new Error("密码长度需为 10-128 位");
  return value;
}

export async function hashPassword(password: string, salt?: string) {
  const passwordSalt = salt ?? randomBytes(16).toString("base64url");
  const result = await deriveKey(password, passwordSalt);
  return { salt: passwordSalt, hash: result.toString("base64url") };
}

export async function verifyPassword(
  password: string,
  salt: string,
  expected: string,
) {
  const actual = Buffer.from(
    (await hashPassword(password, salt)).hash,
    "base64url",
  );
  const target = Buffer.from(expected, "base64url");
  return actual.length === target.length && timingSafeEqual(actual, target);
}

export function createSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
