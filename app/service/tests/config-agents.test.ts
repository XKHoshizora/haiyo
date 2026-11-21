import { describe, expect, test } from "vitest";
import { DEFAULT_REASONING_ALLOWANCE, draftDeadlineMs, loadConfig } from "../src/config.ts";

const base = {
  DATABASE_URL: "postgres://x/y",
  APP_ORIGIN: "http://localhost:5173",
  AUTH_SECRET: "x".repeat(32),
  PROVIDER_KEY_SECRET: "p".repeat(32),
};

const model = {
  id: "fast",
  label: "Fast",
  tier: "free",
  protocol: "openai_chat",
  baseUrl: "https://api.example.test/v1",
  apiKeyEnv: "TEST_UPSTREAM_KEY",
  model: "fast-1",
  inputMicroPerToken: 1,
  outputMicroPerToken: 3,
  maxOutputTokens: 2048,
  contextTokens: 32000,
  vision: false,
  pdf: false,
  reasoning: ["low", "high"],
};

const withModels = (models: unknown, extra: Record<string, string> = { TEST_UPSTREAM_KEY: "upstream-key-value" }) => ({
  ...base,
  ...extra,
  SITE_MODELS: typeof models === "string" ? models : JSON.stringify(models),
});

describe("agent and metering configuration", () => {
  test("defaults", () => {
    expect(loadConfig(base)).toMatchObject({
      providerKeySecret: "p".repeat(32),
      siteModels: [],
      freeDailyMicro: 200_000_000n,
      siteTimezone: "Asia/Shanghai",
      agentTiers: { free: 20 },
      agentMaxConcurrentRuns: 4,
      agentMaxConcurrentOthersRuns: 3,
      agentRunsPerMinute: 20,
      agentOthersRunsPerMinute: 20,
      agentCallerRunsPerMinute: 5,
      agentRunTimeoutMs: 120_000,
      providerDefaultContextTokens: 16_000,
      providerDefaultMaxOutputTokens: 2048,
      providerMaxConcurrentCalls: 64,
      agentMaxRunsInFlight: 16,
      agentChainLimit: 30,
      agentGroupContextTokens: 12_000,
    });
  });

  test("the protective limits are configuration, each a whole number within its range (empty: the default)", () => {
    expect(
      loadConfig({
        ...base,
        AGENT_MAX_CONCURRENT_RUNS: "5",
        AGENT_RUNS_PER_MINUTE: "60",
        AGENT_RUN_TIMEOUT_MS: "30000",
        PROVIDER_DEFAULT_CONTEXT_TOKENS: "32000",
        PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS: "4096",
        PROVIDER_MAX_CONCURRENT_CALLS: "128",
      }),
    ).toMatchObject({
      agentMaxConcurrentRuns: 5,
      agentRunsPerMinute: 60,
      agentRunTimeoutMs: 30_000,
      providerDefaultContextTokens: 32_000,
      providerDefaultMaxOutputTokens: 4096,
      providerMaxConcurrentCalls: 128,
    });
    const ranges: Array<[name: string, field: string, accepted: Array<[string, number]>, refused: string[]]> = [
      ["AGENT_RUNS_PER_MINUTE", "agentRunsPerMinute", [["1", 1], ["10000", 10_000], ["", 20]], ["0", "10001", "-5", "2.5", "lots"]],
      ["AGENT_OTHERS_RUNS_PER_MINUTE", "agentOthersRunsPerMinute", [["1", 1], ["10000", 10_000], ["", 20]], ["0", "10001", "-5", "2.5", "lots"]],
      ["AGENT_CALLER_RUNS_PER_MINUTE", "agentCallerRunsPerMinute", [["1", 1], ["10000", 10_000], ["", 5]], ["0", "10001", "-1", "1.5", "five"]],
      ["AGENT_RUN_TIMEOUT_MS", "agentRunTimeoutMs", [["1000", 1000], ["3600000", 3_600_000], ["", 120_000]], ["999", "3600001", "0", "60s"]],
      ["PROVIDER_DEFAULT_CONTEXT_TOKENS", "providerDefaultContextTokens", [["2049", 2049], ["2000000", 2_000_000], ["", 16_000]], ["999", "2000001", "16k"]],
      ["PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS", "providerDefaultMaxOutputTokens", [["1", 1], ["15999", 15_999], ["", 2048]], ["0", "-1", "1.5"]],
      ["PROVIDER_MAX_CONCURRENT_CALLS", "providerMaxConcurrentCalls", [["1", 1], ["1000", 1000], ["", 64]], ["0", "1001", "many"]],
      ["AGENT_MAX_RUNS_IN_FLIGHT", "agentMaxRunsInFlight", [["1", 1], ["64", 64], ["", 16]], ["0", "65", "-1", "1.5", "many"]],
      ["AGENT_CHAIN_LIMIT", "agentChainLimit", [["2", 2], ["500", 500], ["", 30]], ["0", "1", "501", "-3", "2.5", "thirty"]],
      ["AGENT_GROUP_CONTEXT_TOKENS", "agentGroupContextTokens", [["2000", 2000], ["200000", 200_000], ["", 12_000]], ["0", "1999", "200001", "-1", "1.5", "12k"]],
    ];
    for (const [name, field, accepted, refused] of ranges) {
      for (const [value, parsed] of accepted) expect([name, value, (loadConfig({ ...base, [name]: value }) as any)[field]]).toEqual([name, value, parsed]);
      for (const value of refused) expect(() => loadConfig({ ...base, [name]: value }), `${name}=${value}`).toThrow(new RegExp(name));
    }
  });

  test("an owner's running replies: the total and the most of them others' are whole numbers within their ranges (empty: the default)", () => {
    // Each is tried with the other one set so that only its own range can refuse.
    const ranges: Array<[name: string, field: string, other: Record<string, string>, accepted: Array<[string, number]>, refused: string[]]> = [
      ["AGENT_MAX_CONCURRENT_RUNS", "agentMaxConcurrentRuns", { AGENT_MAX_CONCURRENT_OTHERS_RUNS: "1" }, [["1", 1], ["100", 100], ["", 4]], ["0", "101", "-1", "1.5", "two", "1e2"]],
      ["AGENT_MAX_CONCURRENT_OTHERS_RUNS", "agentMaxConcurrentOthersRuns", { AGENT_MAX_CONCURRENT_RUNS: "100" }, [["1", 1], ["100", 100], ["", 3]], ["0", "101", "-1", "1.5", "three"]],
    ];
    for (const [name, field, other, accepted, refused] of ranges) {
      for (const [value, parsed] of accepted) expect([name, value, (loadConfig({ ...base, ...other, [name]: value }) as any)[field]]).toEqual([name, value, parsed]);
      for (const value of refused) expect(() => loadConfig({ ...base, ...other, [name]: value }), `${name}=${value}`).toThrow(new RegExp(name));
    }
  });

  test("the replies others call for may not be allowed more places than all of an owner's replies: it refuses to start, naming both", () => {
    expect(() => loadConfig({ ...base, AGENT_MAX_CONCURRENT_RUNS: "2", AGENT_MAX_CONCURRENT_OTHERS_RUNS: "3" })).toThrow(
      /AGENT_MAX_CONCURRENT_OTHERS_RUNS.*AGENT_MAX_CONCURRENT_RUNS/,
    );
    // The default others' limit (3) is more than a total of 2 set alone.
    expect(() => loadConfig({ ...base, AGENT_MAX_CONCURRENT_RUNS: "2" })).toThrow(/AGENT_MAX_CONCURRENT_OTHERS_RUNS.*AGENT_MAX_CONCURRENT_RUNS/);
    expect(loadConfig({ ...base, AGENT_MAX_CONCURRENT_RUNS: "3", AGENT_MAX_CONCURRENT_OTHERS_RUNS: "3" })).toMatchObject({
      agentMaxConcurrentRuns: 3,
      agentMaxConcurrentOthersRuns: 3,
    });
  });

  test("the default context of a provider model must be larger than the default output limit, or nothing is left for the conversation", () => {
    expect(() => loadConfig({ ...base, PROVIDER_DEFAULT_CONTEXT_TOKENS: "4096", PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS: "4096" })).toThrow(
      /PROVIDER_DEFAULT_CONTEXT_TOKENS.*PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS/,
    );
    expect(() => loadConfig({ ...base, PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS: "16000" })).toThrow(/PROVIDER_DEFAULT_CONTEXT_TOKENS/);
    expect(loadConfig({ ...base, PROVIDER_DEFAULT_CONTEXT_TOKENS: "4097", PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS: "4096" })).toMatchObject({
      providerDefaultContextTokens: 4097,
      providerDefaultMaxOutputTokens: 4096,
    });
  });

  test("a persona draft must answer before the connection's idle timeout: HTTP_CONNECTION_TIMEOUT_MS less 10 s must leave 10 s", () => {
    // (The connection timeout must also exceed the upload idle deadline, lowered here so only this rule can refuse.)
    const short = { ...base, UPLOAD_IDLE_TIMEOUT_MS: "1000" };
    expect(() => loadConfig({ ...short, HTTP_CONNECTION_TIMEOUT_MS: "19999" })).toThrow(/HTTP_CONNECTION_TIMEOUT_MS/);
    expect(() => loadConfig({ ...short, HTTP_CONNECTION_TIMEOUT_MS: "5000" })).toThrow(/persona draft/);
    const config = loadConfig({ ...short, HTTP_CONNECTION_TIMEOUT_MS: "20000" });
    expect(draftDeadlineMs(config)).toBe(10_000);
    expect(draftDeadlineMs(loadConfig(base))).toBe(110_000); // the defaults: 120 s connection, 120 s runs
    expect(draftDeadlineMs(loadConfig({ ...base, AGENT_RUN_TIMEOUT_MS: "30000" }))).toBe(30_000);
    expect(draftDeadlineMs(loadConfig({ ...base, AGENT_RUN_TIMEOUT_MS: "1000" }))).toBe(1_000);
  });

  test("PROVIDER_KEY_SECRET is required and at least 32 characters", () => {
    const { PROVIDER_KEY_SECRET: _omit, ...without } = base;
    expect(() => loadConfig(without)).toThrow(/PROVIDER_KEY_SECRET/);
    expect(() => loadConfig({ ...base, PROVIDER_KEY_SECRET: "" })).toThrow(/PROVIDER_KEY_SECRET/);
    expect(() => loadConfig({ ...base, PROVIDER_KEY_SECRET: "p".repeat(31) })).toThrow(/PROVIDER_KEY_SECRET/);
    expect(loadConfig({ ...base, PROVIDER_KEY_SECRET: "p".repeat(32) }).providerKeySecret).toHaveLength(32);
  });

  test("SITE_MODELS: a valid list is parsed, the key variable is only named", () => {
    const config = loadConfig(withModels([model]));
    expect(config.siteModels).toEqual([{ ...model, tools: true }]);
    expect(JSON.stringify(config.siteModels)).not.toContain("upstream-key-value");
    expect(loadConfig({ ...base, SITE_MODELS: "" }).siteModels).toEqual([]);
  });

  test("SITE_MODELS: malformed input stops loadConfig with a message naming the variable", () => {
    const bad: [string, unknown][] = [
      ["not json", "{not json"],
      ["not an array", { id: "x" }],
      ["unknown protocol", [{ ...model, protocol: "carrier_pigeon" }]],
      ["negative input price", [{ ...model, inputMicroPerToken: -1 }]],
      ["negative output price", [{ ...model, outputMicroPerToken: -1 }]],
      ["fractional price", [{ ...model, inputMicroPerToken: 0.5 }]],
      ["unknown tier", [{ ...model, tier: "gold" }]],
      ["unknown reasoning level", [{ ...model, reasoning: ["ludicrous"] }]],
      ["missing field", [{ ...model, model: undefined }]],
      ["bad base url", [{ ...model, baseUrl: "not a url" }]],
      ["duplicate ids", [model, model]],
      ["context no larger than the output limit", [{ ...model, contextTokens: 2048 }]],
      ["context smaller than the output limit", [{ ...model, contextTokens: 1000 }]],
    ];
    for (const [name, value] of bad) {
      expect(() => loadConfig(withModels(value)), name).toThrow(/SITE_MODELS/);
    }
  });

  test("SITE_MODELS: a baseUrl follows a provider's rule (https, no credentials, query or fragment), normalised; else start-up fails naming the model", () => {
    for (const baseUrl of [
      "http://api.example.test/v1",
      "https://user:pw@api.example.test/v1",
      "https://@api.example.test/v1",
      "https://api.example.test/v1?key=x",
      "https://api.example.test/v1?",
      "https://api.example.test/v1#frag",
      "https://exa_mple.test/v1",
      "ftp://api.example.test/v1",
    ]) {
      expect(() => loadConfig(withModels([{ ...model, baseUrl }])), baseUrl).toThrow(/SITE_MODELS: model "fast".*baseUrl/);
    }
    expect(loadConfig(withModels([{ ...model, baseUrl: "https://API.Example.test:443/v1/" }])).siteModels[0]!.baseUrl).toBe("https://api.example.test/v1");
    expect(loadConfig(withModels([{ ...model, baseUrl: "https://203.0.113.9:8443/openai/v1" }])).siteModels[0]!.baseUrl).toBe("https://203.0.113.9:8443/openai/v1");
  });

  test("SITE_MODELS: a model's context must be larger than its output limit, or nothing is left for the conversation", () => {
    expect(() => loadConfig(withModels([{ ...model, contextTokens: 2048 }]))).toThrow(/SITE_MODELS: model "fast" has contextTokens 2048, not more than its maxOutputTokens 2048/);
    expect(loadConfig(withModels([{ ...model, contextTokens: 2049 }])).siteModels[0]!.contextTokens).toBe(2049);
  });

  test("SITE_MODELS: an apiKeyEnv that is unset (or empty) fails start-up naming it", () => {
    expect(() => loadConfig(withModels([model], {}))).toThrow(/SITE_MODELS.*TEST_UPSTREAM_KEY/);
    expect(() => loadConfig(withModels([model], { TEST_UPSTREAM_KEY: "" }))).toThrow(/TEST_UPSTREAM_KEY/);
  });

  test("SITE_MODELS: an apiKeyEnv may not name one of the service's own variables: start-up fails naming the model", () => {
    const s3 = { S3_ENDPOINT: "https://s3.example.test", S3_REGION: "r", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "access-id", S3_SECRET_ACCESS_KEY: "s3-secret" };
    expect(loadConfig(withModels([model], { TEST_UPSTREAM_KEY: "upstream-key-value", ...s3 })).siteModels).toHaveLength(1);
    for (const own of ["DATABASE_URL", "AUTH_SECRET", "PROVIDER_KEY_SECRET", "S3_SECRET_ACCESS_KEY", "S3_ACCESS_KEY_ID", "RESEND_API_KEY", "auth_secret"]) {
      // Each of them is set (base, s3, and the lower-case name too), so only the rule can refuse it.
      expect(() => loadConfig(withModels([{ ...model, apiKeyEnv: own }], { ...s3, RESEND_API_KEY: "a-mail-key", auth_secret: "a-lower-case-variable" })), own).toThrow(
        new RegExp(`SITE_MODELS: model "fast".*${own}`),
      );
    }
  });

  test("SITE_MODELS: two models may share one apiKeyEnv (two models of one upstream account)", () => {
    const config = loadConfig(withModels([model, { ...model, id: "slow", label: "Slow", model: "slow-1" }]));
    expect(config.siteModels.map((m) => [m.id, m.apiKeyEnv])).toEqual([
      ["fast", "TEST_UPSTREAM_KEY"],
      ["slow", "TEST_UPSTREAM_KEY"],
    ]);
  });

  test("AGENT_TIERS must contain free and hold whole non-negative limits", () => {
    expect(loadConfig({ ...base, AGENT_TIERS: '{"free":5,"pro":100}' }).agentTiers).toEqual({ free: 5, pro: 100 });
    for (const bad of ['{"pro":100}', "[]", "nope", '{"free":-1}', '{"free":1.5}', '{"free":"3"}']) {
      expect(() => loadConfig({ ...base, AGENT_TIERS: bad }), bad).toThrow(/AGENT_TIERS/);
    }
  });

  test("FREE_DAILY_POINTS is given in points and kept in micro-points", () => {
    expect(loadConfig({ ...base, FREE_DAILY_POINTS: "50" }).freeDailyMicro).toBe(50_000_000n);
    expect(loadConfig({ ...base, FREE_DAILY_POINTS: "0" }).freeDailyMicro).toBe(0n);
    for (const bad of ["-1", "1.5", "lots"]) expect(() => loadConfig({ ...base, FREE_DAILY_POINTS: bad }), bad).toThrow(/FREE_DAILY_POINTS/);
  });

  test("SITE_TIMEZONE must be an IANA zone", () => {
    expect(loadConfig({ ...base, SITE_TIMEZONE: "Europe/Berlin" }).siteTimezone).toBe("Europe/Berlin");
    expect(() => loadConfig({ ...base, SITE_TIMEZONE: "Mars/Olympus" })).toThrow(/SITE_TIMEZONE/);
  });

  test("REASONING_ALLOWANCE_TOKENS: a level's thinking allowance, 0–200 000 each; a level left out keeps its default", () => {
    expect(loadConfig(base).reasoningAllowanceTokens).toEqual({ low: 2000, medium: 6000, high: 12000, xhigh: 24000, max: 48000 });
    expect(loadConfig({ ...base, REASONING_ALLOWANCE_TOKENS: "" }).reasoningAllowanceTokens).toEqual(DEFAULT_REASONING_ALLOWANCE);
    expect(loadConfig({ ...base, REASONING_ALLOWANCE_TOKENS: '{"low":0,"max":200000}' }).reasoningAllowanceTokens).toEqual({
      low: 0,
      medium: 6000,
      high: 12000,
      xhigh: 24000,
      max: 200000,
    });
    for (const bad of ['{"high":-1}', '{"high":200001}', '{"high":1.5}', '{"high":"9"}', '{"none":100}', '{"huge":1}', "[]", "12000", "nope"]) {
      expect(() => loadConfig({ ...base, REASONING_ALLOWANCE_TOKENS: bad }), bad).toThrow(/REASONING_ALLOWANCE_TOKENS/);
    }
  });

  test("SITE_MODELS: thinkingSwitch is optional (absent: not sent) and a boolean", () => {
    expect(loadConfig(withModels([model])).siteModels[0]).not.toHaveProperty("thinkingSwitch");
    expect(loadConfig(withModels([{ ...model, thinkingSwitch: true }])).siteModels[0]!.thinkingSwitch).toBe(true);
    expect(() => loadConfig(withModels([{ ...model, thinkingSwitch: "yes" }]))).toThrow(/SITE_MODELS/);
  });

  test("SITE_MODELS: tools is a boolean, true when absent (its replies may be offered tools); false is the operator's word that it cannot use them", () => {
    expect(loadConfig(withModels([model])).siteModels[0]!.tools).toBe(true);
    expect(loadConfig(withModels([{ ...model, tools: true }])).siteModels[0]!.tools).toBe(true);
    expect(loadConfig(withModels([{ ...model, tools: false }])).siteModels[0]!.tools).toBe(false);
    for (const bad of ["no", 0, null]) expect(() => loadConfig(withModels([{ ...model, tools: bad }])), String(bad)).toThrow(/SITE_MODELS/);
  });
});

const judge = {
  model: "jev-1",
  channels: [
    { url: "https://judge-a.example.test/v1/systemone", apiKeyEnv: "JUDGE_KEY_A" },
    { url: "https://judge-b.example.test/v1/systemone", apiKeyEnv: "JUDGE_KEY_B" },
  ],
  timeoutMs: 2500,
  dailyLimit: 5000,
};
const withJudge = (value: unknown, extra: Record<string, string> = { JUDGE_KEY_A: "key-a", JUDGE_KEY_B: "key-b" }) => ({
  ...base,
  ...extra,
  JUDGE: typeof value === "string" ? value : JSON.stringify(value),
});

describe("the judgement model's configuration", () => {
  test("JUDGE unset or empty: none", () => {
    expect(loadConfig(base).judge).toBeNull();
    expect(loadConfig({ ...base, JUDGE: "" }).judge).toBeNull();
  });

  test("a full valid value is kept, urls whole", () => {
    expect(loadConfig(withJudge(judge)).judge).toEqual(judge);
  });

  test("a channel's url is the endpoint itself: its path is kept exactly as given, a trailing slash too", () => {
    for (const url of ["https://h.example.test/v1/systemone/", "https://h.example.test/v1/systemone"]) {
      const one = { model: "m", channels: [{ url, apiKeyEnv: "JUDGE_KEY_A" }] };
      expect(loadConfig(withJudge(one)).judge!.channels[0]!.url).toBe(url);
    }
  });

  test("a key variable may not be one of the service's own (in any case): start-up refuses", () => {
    for (const own of ["DATABASE_URL", "database_url", "AUTH_SECRET"]) {
      const value = { model: "m", channels: [{ url: "https://h.example.test/v1/systemone", apiKeyEnv: own }] };
      // Each is set, so only the rule can refuse it.
      expect(() => loadConfig(withJudge(value, { database_url: "a-lower-case-variable" })), own).toThrow(new RegExp(`JUDGE: a channel names ${own}`));
    }
  });

  test("timeout and daily limit default; one channel is enough", () => {
    const one = { model: "m", channels: [judge.channels[0]] };
    expect(loadConfig(withJudge(one)).judge).toEqual({ model: "m", channels: [judge.channels[0]], timeoutMs: 4000, dailyLimit: 20_000 });
  });

  test("a key variable that is not set (or empty) refuses start-up, naming it", () => {
    expect(() => loadConfig(withJudge(judge, { JUDGE_KEY_A: "key-a" }))).toThrow(/JUDGE_KEY_B/);
    expect(() => loadConfig(withJudge(judge, { JUDGE_KEY_A: "key-a", JUDGE_KEY_B: "" }))).toThrow(/JUDGE_KEY_B/);
  });

  test("an http url, one with credentials, a query or a fragment, no channel and three channels refuse", () => {
    const channel = judge.channels[0]!;
    const bad = [
      { ...judge, channels: [{ ...channel, url: "http://judge-a.example.test/v1" }] },
      { ...judge, channels: [{ ...channel, url: "https://user:pw@judge-a.example.test/v1" }] },
      { ...judge, channels: [{ ...channel, url: "https://judge-a.example.test/v1?x=1" }] },
      { ...judge, channels: [{ ...channel, url: "https://judge-a.example.test/v1#x" }] },
      { ...judge, channels: [] },
      { ...judge, channels: [channel, channel, channel] },
      { ...judge, timeoutMs: 100 },
      { ...judge, dailyLimit: 0 },
      { ...judge, extra: 1 },
    ];
    for (const value of bad) expect(() => loadConfig(withJudge(value)), JSON.stringify(value)).toThrow(/JUDGE/);
    expect(() => loadConfig(withJudge("nope"))).toThrow(/JUDGE/);
  });
});

describe("the proactive replies' configuration", () => {
  const defaults = {
    debounceMs: 3000,
    transcriptMessages: 15,
    transcriptChars: 300,
    base: { less: 0.8, normal: 0.65, more: 0.5 },
    surchargeStep: 0.1,
    surchargeMax: 0.25,
    surchargeHalfLifeS: 120,
    surchargeHalfMessages: 4,
    quietBig: { at: 0.8, raise: 0.33, halfLifeS: 3600 },
    quietSmall: { at: 0.3, raise: 0.15, halfLifeS: 600 },
    cap: 0.98,
    fuse: { perSeconds: 10, perHour: 30 },
    perGroupHour: 600,
    perSenderHour: 300,
  };

  test("unset or empty: every default", () => {
    expect(loadConfig(base).proactive).toEqual(defaults);
    expect(loadConfig({ ...base, PROACTIVE: "" }).proactive).toEqual(defaults);
    expect(loadConfig({ ...base, PROACTIVE: "{}" }).proactive).toEqual(defaults);
  });

  test("one override keeps the rest, nested ones too", () => {
    expect(loadConfig({ ...base, PROACTIVE: '{"debounceMs":1000}' }).proactive).toEqual({ ...defaults, debounceMs: 1000 });
    expect(loadConfig({ ...base, PROACTIVE: '{"base":{"less":0.7}}' }).proactive).toEqual({ ...defaults, base: { ...defaults.base, less: 0.7 } });
    expect(loadConfig({ ...base, PROACTIVE: '{"perGroupHour":30,"perSenderHour":10}' }).proactive).toEqual({ ...defaults, perGroupHour: 30, perSenderHour: 10 });
  });

  test("a probability outside [0, 1], a non-whole count, an unknown key (also nested) and bad JSON refuse", () => {
    for (const bad of [
      '{"cap":1.5}',
      '{"surchargeStep":-0.1}',
      '{"base":{"less":2}}',
      '{"quietBig":{"at":1.1}}',
      '{"transcriptMessages":0}',
      '{"debounceMs":1.5}',
      '{"fuse":{"perHour":0}}',
      '{"perGroupHour":0}',
      '{"perSenderHour":1.5}',
      '{"perSenderHour":"120"}',
      '{"nope":1}',
      // Gone with the staged judgement: one call now asks about every Agent at once.
      '{"perCall":8}',
      '{"maxCandidates":40}',
      '{"gateAt":0.5}',
      '{"base":{"nope":0.5}}',
      "[]",
      "nope",
    ]) {
      expect(() => loadConfig({ ...base, PROACTIVE: bad }), bad).toThrow(/PROACTIVE/);
    }
  });
});

describe("the tools configuration", () => {
  const defaults = { enabled: true, maxRounds: 8, maxPoints: 20, searchPerReply: 6, filePerReply: 4, timePerReply: 1, resultMaxWeight: 3000, runTimeoutMs: 300_000 };

  test("unset or empty: every default", () => {
    expect(loadConfig(base).tools).toEqual(defaults);
    expect(loadConfig({ ...base, TOOLS: "" }).tools).toEqual(defaults);
    expect(loadConfig({ ...base, TOOLS: "{}" }).tools).toEqual(defaults);
  });

  test("an override keeps the rest; tools can be turned off", () => {
    expect(loadConfig({ ...base, TOOLS: '{"maxRounds":3,"resultMaxWeight":500}' }).tools).toEqual({ ...defaults, maxRounds: 3, resultMaxWeight: 500 });
    expect(loadConfig({ ...base, TOOLS: '{"enabled":false}' }).tools).toEqual({ ...defaults, enabled: false });
    expect(loadConfig({ ...base, TOOLS: '{"runTimeoutMs":1000}' }).tools.runTimeoutMs).toBe(1000);
    // Each tool has its own count: the clock's as the others'.
    expect(loadConfig({ ...base, TOOLS: '{"timePerReply":3}' }).tools).toEqual({ ...defaults, timePerReply: 3 });
  });

  test("a count that is not a whole number of at least 1, a time out of range, an unknown key and bad JSON refuse", () => {
    for (const bad of [
      '{"maxRounds":0}',
      '{"maxRounds":1.5}',
      '{"maxRounds":51}',
      '{"maxPoints":0}',
      '{"searchPerReply":0}',
      '{"filePerReply":-1}',
      '{"timePerReply":0}',
      '{"timePerReply":1001}',
      '{"resultMaxWeight":0}',
      '{"runTimeoutMs":999}',
      '{"runTimeoutMs":3600001}',
      '{"enabled":"yes"}',
      '{"maxRounds":"8"}',
      '{"nope":1}',
      "[]",
      "nope",
    ]) {
      expect(() => loadConfig({ ...base, TOOLS: bad }), bad).toThrow(/TOOLS/);
    }
  });
});

describe("the holds and allowance configuration", () => {
  test("unset or empty: every default", () => {
    expect(loadConfig(base).holds).toEqual({ maxOpenShare: 1 });
    expect(loadConfig({ ...base, HOLDS: "" }).holds).toEqual({ maxOpenShare: 1 });
    expect(loadConfig({ ...base, HOLDS: "{}" }).holds).toEqual({ maxOpenShare: 1 });
    expect(loadConfig(base).allowance).toEqual({ warnAt: 0.8 });
    expect(loadConfig({ ...base, ALLOWANCE: "" }).allowance).toEqual({ warnAt: 0.8 });
    expect(loadConfig({ ...base, ALLOWANCE: "{}" }).allowance).toEqual({ warnAt: 0.8 });
  });

  test("an override: a share from 0.01 to 1; a warning point above 0 and below 1", () => {
    expect(loadConfig({ ...base, HOLDS: '{"maxOpenShare":0.5}' }).holds).toEqual({ maxOpenShare: 0.5 });
    expect(loadConfig({ ...base, HOLDS: '{"maxOpenShare":0.01}' }).holds).toEqual({ maxOpenShare: 0.01 });
    expect(loadConfig({ ...base, HOLDS: '{"maxOpenShare":1}' }).holds).toEqual({ maxOpenShare: 1 });
    expect(loadConfig({ ...base, ALLOWANCE: '{"warnAt":0.9}' }).allowance).toEqual({ warnAt: 0.9 });
  });

  test("a share below 0.01 (it would round to nothing) or above 1 (the holds of replies running together could then pass what is left), a warning point out of range, an unknown key and bad JSON refuse", () => {
    for (const bad of ['{"maxOpenShare":0}', '{"maxOpenShare":0.001}', '{"maxOpenShare":-0.5}', '{"maxOpenShare":1.01}', '{"maxOpenShare":"1"}', '{"nope":1}', "[]", "nope"]) {
      expect(() => loadConfig({ ...base, HOLDS: bad }), bad).toThrow(/HOLDS/);
    }
    for (const bad of ['{"warnAt":0}', '{"warnAt":1}', '{"warnAt":1.5}', '{"warnAt":"0.8"}', '{"nope":1}', "[]", "nope"]) {
      expect(() => loadConfig({ ...base, ALLOWANCE: bad }), bad).toThrow(/ALLOWANCE/);
    }
  });
});

describe("the whispers configuration", () => {
  test("unset or empty: a found-elsewhere whisper expires 24 hours after it was made", () => {
    expect(loadConfig(base).whispers).toEqual({ elsewhereTtlHours: 24 });
    expect(loadConfig({ ...base, WHISPERS: "" }).whispers).toEqual({ elsewhereTtlHours: 24 });
    expect(loadConfig({ ...base, WHISPERS: "{}" }).whispers).toEqual({ elsewhereTtlHours: 24 });
  });

  test("an override: whole hours from 1 to 168 (a week, how long other whispers stay open)", () => {
    expect(loadConfig({ ...base, WHISPERS: '{"elsewhereTtlHours":1}' }).whispers).toEqual({ elsewhereTtlHours: 1 });
    expect(loadConfig({ ...base, WHISPERS: '{"elsewhereTtlHours":168}' }).whispers).toEqual({ elsewhereTtlHours: 168 });
  });

  test("0, a fraction, more than a week, a string, an unknown key and bad JSON refuse", () => {
    for (const bad of ['{"elsewhereTtlHours":0}', '{"elsewhereTtlHours":1.5}', '{"elsewhereTtlHours":169}', '{"elsewhereTtlHours":"24"}', '{"nope":1}', "[]", "nope"]) {
      expect(() => loadConfig({ ...base, WHISPERS: bad }), bad).toThrow(/WHISPERS/);
    }
  });
});

describe("the memory configuration", () => {
  const defaults = {
    model: null,
    roomOwner: 2000,
    roomSelf: 3000,
    roomHearsay: 2000,
    modelEntryMax: 200,
    quietMs: 600_000,
    maxReplies: 8,
    groupQuietMs: 120_000,
    groupMaxWaitMs: 900_000,
    reviewMessages: 40,
    reviewMessageWeight: 500,
    reviewMaxOutputTokens: 2000,
    shareAt: 0.6,
    sameAt: 0.8,
    hearsayAt: 0.65,
    ownAt: 0.6,
    flaggedMax: 20,
    flaggedContext: 3,
    hearsayPerHour: 4,
    catchUpLines: 200,
    catchUpDays: 30,
    hearsayNewAt: 0.7,
    hearsayAbuseAt: 0.6,
    hearsayMuteMs: 21_600_000,
    hearsayMute: "observe",
    listenShare: 0.5,
    dreamSweepMs: 900_000,
    dreamIdleMs: 10_800_000,
    dreamEveryMs: 72_000_000,
    napAt: 0.8,
    faithfulAt: 0.6,
    judgePerOwnerDay: 300,
    judgeShare: 0.5,
    explicitAt: 0.7,
    mergeAuto: "on",
    roomNotes: 150,
    passageShare: 0.25,
    freeDailyPoints: 20,
    changesSweepMs: 3_600_000,
    summaryMaxWeight: 1000,
    summaryMinIntervalMs: 600_000,
    summaryMinFoldWeight: 500,
  };

  test("unset or empty: every default", () => {
    expect(loadConfig(base).memory).toEqual(defaults);
    expect(loadConfig({ ...base, MEMORY: "" }).memory).toEqual(defaults);
    expect(loadConfig({ ...base, MEMORY: "{}" }).memory).toEqual(defaults);
  });

  test("an override keeps the rest", () => {
    expect(loadConfig({ ...base, MEMORY: '{"model":"fast","quietMs":1000,"shareAt":0.9}' }).memory).toEqual({ ...defaults, model: "fast", quietMs: 1000, shareAt: 0.9 });
  });

  test("the review's per-message cut is reviewMessageWeight; the old name reviewMessageChars is still read when the new one is absent", () => {
    expect(loadConfig({ ...base, MEMORY: '{"reviewMessageWeight":300}' }).memory.reviewMessageWeight).toBe(300);
    const old = loadConfig({ ...base, MEMORY: '{"reviewMessageChars":300,"quietMs":1000}' }).memory;
    expect(old).toMatchObject({ reviewMessageWeight: 300, quietMs: 1000, roomOwner: 2000 });
    expect(old).not.toHaveProperty("reviewMessageChars");
    // Both: the new name wins.
    expect(loadConfig({ ...base, MEMORY: '{"reviewMessageChars":300,"reviewMessageWeight":700}' }).memory.reviewMessageWeight).toBe(700);
    for (const bad of ['{"reviewMessageChars":0}', '{"reviewMessageWeight":0}', '{"reviewMessageChars":"5"}']) expect(() => loadConfig({ ...base, MEMORY: bad }), bad).toThrow(/MEMORY/);
  });

  test("the memory-change sweep has its own interval, changesSweepMs: an hour by default, 0 for no timer at all, a whole number of ms up to a day", () => {
    expect(loadConfig({ ...base, MEMORY: '{"changesSweepMs":0}' }).memory.changesSweepMs).toBe(0);
    expect(loadConfig({ ...base, MEMORY: '{"changesSweepMs":60000}' }).memory.changesSweepMs).toBe(60_000);
    // 0, or at least a minute: anything between would sweep back to back.
    for (const bad of ['{"changesSweepMs":1}', '{"changesSweepMs":59999}']) expect(() => loadConfig({ ...base, MEMORY: bad }), bad).toThrow(/MEMORY/);
    // Not borrowed from the attachment sweep's setting.
    expect(loadConfig({ ...base, SWEEP_INTERVAL_MINUTES: "0" }).memory.changesSweepMs).toBe(3_600_000);
    for (const bad of ['{"changesSweepMs":-1}', '{"changesSweepMs":1.5}', '{"changesSweepMs":86400001}', '{"changesSweepMs":"3600000"}']) expect(() => loadConfig({ ...base, MEMORY: bad }), bad).toThrow(/MEMORY/);
  });

  test("what a review does with a merge op, mergeAuto: on by default (the notes joined in their own words, at once), or off (the op ignored); the removed setting reviewMergeAt and the removed value observe are refused at start-up, as any unknown key or value is", () => {
    for (const mode of ["off", "on"]) expect(loadConfig({ ...base, MEMORY: JSON.stringify({ mergeAuto: mode }) }).memory.mergeAuto).toBe(mode);
    for (const bad of ['{"mergeAuto":"observe"}', '{"mergeAuto":"yes"}', '{"mergeAuto":true}', '{"mergeAuto":null}']) expect(() => loadConfig({ ...base, MEMORY: bad }), bad).toThrow(/MEMORY.*mergeAuto/);
    for (const bad of ['{"reviewMergeAt":0.7}', '{"reviewMergeAt":0.7,"mergeAuto":"on"}']) expect(() => loadConfig({ ...base, MEMORY: bad }), bad).toThrow(/MEMORY.*reviewMergeAt/);
    expect(loadConfig({ ...base, MEMORY: "{}" }).memory).not.toHaveProperty("reviewMergeAt");
  });

  test("the rolling summary: a summary of at most 1000 weight as shown, a call only for at least summaryMinFoldWeight of material, half the cap by default; whole numbers, the cap at most 2000 (the database guards a summary's items at 256 KiB); the removed summaryMinMessages is refused at start-up, as any unknown key is", () => {
    expect(loadConfig({ ...base, MEMORY: '{"summaryMaxWeight":2000}' }).memory).toMatchObject({ summaryMaxWeight: 2000, summaryMinFoldWeight: 1000 });
    expect(loadConfig({ ...base, MEMORY: '{"summaryMaxWeight":801}' }).memory).toMatchObject({ summaryMaxWeight: 801, summaryMinFoldWeight: 400 });
    expect(loadConfig({ ...base, MEMORY: '{"summaryMinFoldWeight":50}' }).memory).toMatchObject({ summaryMaxWeight: 1000, summaryMinFoldWeight: 50 });
    for (const bad of ['{"summaryMaxWeight":0}', '{"summaryMaxWeight":2001}', '{"summaryMaxWeight":"800"}', '{"summaryMinFoldWeight":0}', '{"summaryMinFoldWeight":1.5}', '{"summaryMinFoldWeight":100001}']) {
      expect(() => loadConfig({ ...base, MEMORY: bad }), bad).toThrow(/MEMORY/);
    }
    for (const bad of ['{"summaryMinMessages":20}', '{"summaryMinMessages":5,"summaryMaxWeight":800}']) expect(() => loadConfig({ ...base, MEMORY: bad }), bad).toThrow(/MEMORY.*summaryMinMessages/);
    // The interval between a pair's summary calls after one is written: ten minutes by default, 0 for none, at most a day.
    expect(loadConfig({ ...base, MEMORY: '{"summaryMinIntervalMs":0}' }).memory.summaryMinIntervalMs).toBe(0);
    for (const bad of ['{"summaryMinIntervalMs":-1}', '{"summaryMinIntervalMs":1.5}', '{"summaryMinIntervalMs":86400001}']) expect(() => loadConfig({ ...base, MEMORY: bad }), bad).toThrow(/MEMORY/);
    // A review's window no longer has to hold a summary's minimum: any size the review allows is accepted.
    expect(loadConfig({ ...base, MEMORY: '{"reviewMessages":10}' }).memory).toMatchObject({ reviewMessages: 10 });
  });

  test("the hearsay limits can be set", () => {
    expect(loadConfig({ ...base, MEMORY: '{"hearsayPerHour":2,"hearsayNewAt":0.3,"hearsayAbuseAt":0.9,"hearsayMuteMs":1000,"hearsayMute":"on"}' }).memory).toMatchObject({ hearsayPerHour: 2, hearsayNewAt: 0.3, hearsayAbuseAt: 0.9, hearsayMuteMs: 1000, hearsayMute: "on" });
    expect(loadConfig({ ...base, MEMORY: '{"catchUpLines":50,"catchUpDays":7}' }).memory).toMatchObject({ catchUpLines: 50, catchUpDays: 7 });
    for (const bad of ['{"catchUpLines":0}', '{"catchUpDays":366}', '{"catchUpLines":1.5}']) expect(() => loadConfig({ ...base, MEMORY: bad }), bad).toThrow(/MEMORY/);
  });

  test("a threshold outside [0, 1], a non-whole or non-positive count, an unknown key and bad JSON refuse", () => {
    // A room cannot be configured past what the database guards (a note is held to 9000 characters), nor a model's entry past 200.
    for (const bad of ['{"roomOwner":3001}', '{"roomSelf":3001}', '{"roomHearsay":3001}', '{"modelEntryMax":201}']) expect(() => loadConfig({ ...base, MEMORY: bad }), bad).toThrow(/MEMORY/);
    expect(loadConfig({ ...base, MEMORY: '{"roomOwner":3000,"modelEntryMax":100}' }).memory).toMatchObject({ roomOwner: 3000, modelEntryMax: 100 });
    expect(loadConfig({ ...base, MEMORY: '{"judgeShare":0.25}' }).memory.judgeShare).toBe(0.25);
    expect(loadConfig({ ...base, MEMORY: '{"explicitAt":0.85}' }).memory.explicitAt).toBe(0.85);
    expect(loadConfig({ ...base, MEMORY: '{"explicitAt":1}' }).memory.explicitAt).toBe(1);
    for (const bad of ['{"explicitAt":0}', '{"explicitAt":1.5}', '{"explicitAt":-0.1}', '{"explicitAt":"0.7"}', '{"judgeShare":1.5}', '{"judgeShare":-0.1}', '{"listenShare":1.5}', '{"shareAt":1.5}', '{"sameAt":-0.1}', '{"quietMs":0}', '{"hearsayPerHour":0}', '{"hearsayPerHour":1.5}', '{"hearsayAbuseAt":2}', '{"hearsayMuteMs":0}', '{"hearsayMute":"yes"}', '{"maxReplies":1.5}', '{"roomOwner":"2000"}', '{"judgePerOwnerDay":0}', '{"roomNotes":1.5}', '{"passageShare":0}', '{"passageShare":1.5}', '{"freeDailyPoints":-1}', '{"freeDailyPoints":1.5}', '{"model":""}', '{"nope":1}', "[]", "nope"]) {
      expect(() => loadConfig({ ...base, MEMORY: bad }), bad).toThrow(/MEMORY/);
    }
  });
});

describe("the automatic-retry configuration (AGENTS)", () => {
  test("unset or empty: retried after 20 seconds, then 2 minutes", () => {
    expect(loadConfig(base).agents).toEqual({ autoRetryDelaysMs: [20_000, 120_000] });
    expect(loadConfig({ ...base, AGENTS: "" }).agents).toEqual({ autoRetryDelaysMs: [20_000, 120_000] });
    expect(loadConfig({ ...base, AGENTS: "{}" }).agents).toEqual({ autoRetryDelaysMs: [20_000, 120_000] });
  });

  test("an override: at most two waits, each 0 to 600 000 ms; an empty list turns it off", () => {
    expect(loadConfig({ ...base, AGENTS: '{"autoRetryDelaysMs":[]}' }).agents).toEqual({ autoRetryDelaysMs: [] });
    expect(loadConfig({ ...base, AGENTS: '{"autoRetryDelaysMs":[5000]}' }).agents).toEqual({ autoRetryDelaysMs: [5000] });
    expect(loadConfig({ ...base, AGENTS: '{"autoRetryDelaysMs":[0,600000]}' }).agents).toEqual({ autoRetryDelaysMs: [0, 600_000] });
  });

  test("three waits, a wait past ten minutes, a negative or fractional one, a string, an unknown key and bad JSON refuse", () => {
    for (const bad of ['{"autoRetryDelaysMs":[1,2,3]}', '{"autoRetryDelaysMs":[600001]}', '{"autoRetryDelaysMs":[-1]}', '{"autoRetryDelaysMs":[1.5]}', '{"autoRetryDelaysMs":"20000"}', '{"nope":1}', "[]", "nope"]) {
      expect(() => loadConfig({ ...base, AGENTS: bad }), bad).toThrow(/AGENTS/);
    }
  });
});
