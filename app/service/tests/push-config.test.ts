import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { SERVICE_SECRET_VARIABLES, loadConfig } from "../src/config.ts";

/**
 * The push variables (README "Push notifications"): `APPLE_TEAM_ID`, `APPLE_BUNDLE_ID` (the push topic), `APNS_KEY_ID` and
 * `APNS_KEY_P8`. All four: pushes are sent. Any missing or malformed: none are, and nothing else changes — never a refused
 * start (a chat service must not fail to boot because of a push key); one warning at start names them (tests/push-notify).
 */

const base = { DATABASE_URL: "postgres://x/y", APP_ORIGIN: "https://haiyo.example", AUTH_SECRET: "x".repeat(32), PROVIDER_KEY_SECRET: "p".repeat(32) };
const PEM = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ALL = { APPLE_TEAM_ID: "ABCDE12345", APPLE_BUNDLE_ID: "org.haiyo.app", APNS_KEY_ID: "KEY1234567", APNS_KEY_P8: PEM };

describe("push configuration", () => {
  test("all four set: push is configured, the topic is the bundle id", () => {
    const { apple } = loadConfig({ ...base, ...ALL });
    expect(apple.push).toEqual({ teamId: "ABCDE12345", topic: "org.haiyo.app", keyId: "KEY1234567", keyPem: PEM.trim() });
    expect(apple.missing).toEqual([]);
  });

  test("none set: no push, nothing missing (the site simply has no app)", () => {
    const { apple } = loadConfig(base);
    expect(apple.push).toBeNull();
    expect(apple.missing).toEqual([]);
  });

  test("the key missing (or empty): no push, the start goes on, and the missing variable is named", () => {
    for (const key of [undefined, ""]) {
      const env: Record<string, string | undefined> = { ...base, ...ALL, APNS_KEY_P8: key };
      const { apple } = loadConfig(env);
      expect(apple.push).toBeNull();
      expect(apple.missing).toEqual(["APNS_KEY_P8"]);
      // The universal links do not need the key.
      expect(apple.app).toEqual({ teamId: "ABCDE12345", bundleId: "org.haiyo.app" });
    }
    expect(loadConfig({ ...base, APNS_KEY_ID: "KEY1234567", APNS_KEY_P8: PEM }).apple.missing).toEqual(["APPLE_TEAM_ID", "APPLE_BUNDLE_ID"]);
  });

  test("a key pasted on one line with \\n escapes is read as the PEM it is", () => {
    const oneLine = PEM.trim().replace(/\n/g, "\\n");
    expect(loadConfig({ ...base, ...ALL, APNS_KEY_P8: oneLine }).apple.push?.keyPem).toBe(PEM.trim());
  });

  test("a key that is no P-256 private key never stops the start: push is off, the variable is named as malformed, and nothing of the key is kept", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const secp384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    for (const bad of ["not-a-key-CANARY-KEY-TEXT", rsa, secp384, PEM.replace("PRIVATE KEY", "PUBLIC KEY")]) {
      const { apple } = loadConfig({ ...base, ...ALL, APNS_KEY_P8: bad });
      expect(apple.push).toBeNull();
      expect(apple.malformed).toEqual(["APNS_KEY_P8"]);
      expect(apple.missing).toEqual([]);
      const kept = JSON.stringify(apple);
      expect(kept).not.toContain("CANARY-KEY-TEXT");
      expect(kept).not.toContain(bad.split("\n")[1] ?? bad);
      // The universal links do not need the key.
      expect(apple.app).toEqual({ teamId: "ABCDE12345", bundleId: "org.haiyo.app" });
    }
  });

  test("a malformed key id: push is off, APNS_KEY_ID named as malformed, the start goes on", () => {
    for (const bad of ["key1234567", "KEY123456", "KEY12345678"]) {
      const { apple } = loadConfig({ ...base, ...ALL, APNS_KEY_ID: bad });
      expect([bad, apple.push, apple.malformed]).toEqual([bad, null, ["APNS_KEY_ID"]]);
    }
  });

  test("APNS_KEY_P8 is one of the service's own secrets: no site model may name it as its key", () => {
    expect(SERVICE_SECRET_VARIABLES).toContain("APNS_KEY_P8");
    const model = {
      id: "fast",
      label: "Fast",
      tier: "free",
      protocol: "openai_chat",
      baseUrl: "https://api.example.test/v1",
      apiKeyEnv: "APNS_KEY_P8",
      model: "m",
      inputMicroPerToken: 1,
      outputMicroPerToken: 1,
      maxOutputTokens: 1024,
      contextTokens: 8192,
      vision: false,
      pdf: false,
      reasoning: [],
    };
    expect(() => loadConfig({ ...base, ...ALL, SITE_MODELS: JSON.stringify([model]) })).toThrow(/SITE_MODELS: model "fast".*APNS_KEY_P8/);
  });
});
