import { describe, expect, test } from "bun:test";
import { AmberApiError, AmberClient, AmberRateLimitError, intervalStartFromNemTime, nemTimeToUtc } from "./client";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/** Fake `fetch` that returns one Response per call, from a fixed queue (last one repeats if exhausted). */
function makeFetchQueue(responses: Response[]): { fetchFn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!response) throw new Error("makeFetchQueue: no response configured");
    return response;
  }) as typeof fetch;
  return { fetchFn, calls };
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

/** Minimal valid ActualInterval/CurrentInterval/ForecastInterval fixture, per docs/amber-api.md §4. */
function makeRawInterval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "ActualInterval",
    duration: 5,
    spotPerKwh: 10,
    perKwh: 12,
    date: "2024-01-01",
    nemTime: "2024-01-01T00:05:00+10:00",
    startTime: "2023-12-31T14:00:00Z",
    endTime: "2023-12-31T14:05:00Z",
    renewables: 45,
    channelType: "general",
    tariffInformation: null,
    spikeStatus: "none",
    descriptor: "neutral",
    ...overrides,
  };
}

function noSleep(): (ms: number) => Promise<void> {
  return async () => {
    /* no-op — tests never wait for real backoff delays */
  };
}

describe("AmberClient — feed-in sign normalisation", () => {
  test("feedIn perKwh/spotPerKwh are negated so positive means you earn", async () => {
    const general = makeRawInterval({ channelType: "general", perKwh: 25.5, spotPerKwh: 8 });
    const feedIn = makeRawInterval({ channelType: "feedIn", perKwh: -8.5, spotPerKwh: -7 });
    const { fetchFn } = makeFetchQueue([jsonResponse([general, feedIn])]);
    const client = new AmberClient("token", { fetchFn, sleepFn: noSleep() });

    const intervals = await client.getCurrentPrices("site-1");
    const generalResult = intervals.find((i) => i.channelType === "general");
    const feedInResult = intervals.find((i) => i.channelType === "feedIn");

    expect(generalResult?.perKwh).toBe(25.5);
    expect(generalResult?.spotPerKwh).toBe(8);
    // Raw feedIn perKwh -8.5 (you're paid) becomes +8.5 (you earn 8.5c/kWh).
    expect(feedInResult?.perKwh).toBe(8.5);
    expect(feedInResult?.spotPerKwh).toBe(7);
  });

  test("a positive feedIn perKwh (negative-FiT event) becomes negative (a cost) after normalisation", async () => {
    const feedIn = makeRawInterval({ channelType: "feedIn", perKwh: 3.2, spotPerKwh: 4 });
    const { fetchFn } = makeFetchQueue([jsonResponse([feedIn])]);
    const client = new AmberClient("token", { fetchFn, sleepFn: noSleep() });

    const [result] = await client.getCurrentPrices("site-1");
    expect(result?.perKwh).toBe(-3.2);
    expect(result?.spotPerKwh).toBe(-4);
  });
});

describe("NEM time conversion", () => {
  test("nemTimeToUtc treats a fixed +10:00 offset when none is present in the string", () => {
    // NEM time has no DST — this must hold year-round, including months when
    // NSW/VIC/SA local clocks would otherwise be on daylight saving.
    const winter = nemTimeToUtc("2024-06-01T00:05:00");
    expect(winter.toISOString()).toBe("2024-05-31T14:05:00.000Z");

    const summerNemDate = nemTimeToUtc("2024-01-01T00:05:00");
    expect(summerNemDate.toISOString()).toBe("2023-12-31T14:05:00.000Z");
  });

  test("nemTimeToUtc respects an explicit offset already present in the string", () => {
    const withOffset = nemTimeToUtc("2024-06-01T00:05:00+10:00");
    expect(withOffset.toISOString()).toBe("2024-05-31T14:05:00.000Z");

    const withZ = nemTimeToUtc("2024-06-01T00:05:00Z");
    expect(withZ.toISOString()).toBe("2024-06-01T00:05:00.000Z");
  });

  test("intervalStartFromNemTime subtracts duration from the interval end (nemTime)", () => {
    // nemTime is documented as interval-ENDING; interval start = end - duration.
    const start = intervalStartFromNemTime("2024-01-01T00:05:00+10:00", 5);
    expect(start.toISOString()).toBe("2023-12-31T14:00:00.000Z");

    const start30 = intervalStartFromNemTime("2024-01-01T00:30:00+10:00", 30);
    expect(start30.toISOString()).toBe("2023-12-31T14:00:00.000Z");
  });

  test("client normalises intervalStart via nemTime - duration, not the raw startTime field", async () => {
    // startTime is deliberately "wrong" here to prove intervalStart is derived from
    // nemTime/duration, matching docs/amber-api.md's interval-ending convention.
    const interval = makeRawInterval({
      nemTime: "2024-03-10T10:30:00+10:00",
      duration: 30,
      startTime: "1999-01-01T00:00:00Z",
    });
    const { fetchFn } = makeFetchQueue([jsonResponse([interval])]);
    const client = new AmberClient("token", { fetchFn, sleepFn: noSleep() });

    const [result] = await client.getCurrentPrices("site-1");
    expect(result?.intervalStart.toISOString()).toBe("2024-03-10T00:00:00.000Z");
  });
});

describe("zod tolerance of unknown enum values", () => {
  test("unknown descriptor and spikeStatus values pass through without throwing", async () => {
    const interval = makeRawInterval({
      descriptor: "somethingBrandNew",
      spikeStatus: "extraSpiky",
    });
    const { fetchFn } = makeFetchQueue([jsonResponse([interval])]);
    const client = new AmberClient("token", { fetchFn, sleepFn: noSleep() });

    const [result] = await client.getCurrentPrices("site-1");
    expect(result?.descriptor).toBe("somethingBrandNew");
    expect(result?.spikeStatus).toBe("extraSpiky");
  });

  test("unknown extra fields on the interval pass through instead of failing validation", async () => {
    const interval = makeRawInterval({ someFutureField: { nested: true } });
    const { fetchFn } = makeFetchQueue([jsonResponse([interval])]);
    const client = new AmberClient("token", { fetchFn, sleepFn: noSleep() });

    const intervals = await client.getCurrentPrices("site-1");
    expect(intervals.length).toBe(1);
  });

  test("an interval with a genuinely unrecognised type is skipped, not fatal to the batch", async () => {
    const good = makeRawInterval();
    const bad = makeRawInterval({ type: "SomeFutureIntervalType" });
    const { fetchFn } = makeFetchQueue([jsonResponse([good, bad])]);
    const client = new AmberClient("token", { fetchFn, sleepFn: noSleep() });

    const intervals = await client.getCurrentPrices("site-1");
    expect(intervals.length).toBe(1);
  });
});

describe("CurrentInterval / ForecastInterval specific fields", () => {
  test("advancedPrice and estimate are parsed for CurrentInterval", async () => {
    const current = makeRawInterval({
      type: "CurrentInterval",
      estimate: true,
      advancedPrice: { low: 10, predicted: 15, high: 20 },
    });
    const { fetchFn } = makeFetchQueue([jsonResponse([current])]);
    const client = new AmberClient("token", { fetchFn, sleepFn: noSleep() });

    const [result] = await client.getCurrentPrices("site-1");
    expect(result?.estimate).toBe(true);
    expect(result?.advancedPrice).toEqual({ low: 10, predicted: 15, high: 20 });
  });

  test("advancedPrice is parsed for ForecastInterval; estimate is null (not applicable)", async () => {
    const forecast = makeRawInterval({
      type: "ForecastInterval",
      advancedPrice: { low: 5, predicted: 8, high: 11 },
    });
    const { fetchFn } = makeFetchQueue([jsonResponse([forecast])]);
    const client = new AmberClient("token", { fetchFn, sleepFn: noSleep() });

    const [result] = await client.getCurrentPrices("site-1");
    expect(result?.estimate).toBeNull();
    expect(result?.advancedPrice).toEqual({ low: 5, predicted: 8, high: 11 });
  });
});

describe("rate limiting / retry behaviour", () => {
  test("a single 429 is retried once, honouring the Retry-After header", async () => {
    const good = makeRawInterval();
    const { fetchFn, calls } = makeFetchQueue([
      jsonResponse([], { status: 429, headers: { "Retry-After": "2" } }),
      jsonResponse([good]),
    ]);
    const sleepCalls: number[] = [];
    const sleepFn = async (ms: number) => {
      sleepCalls.push(ms);
    };
    const client = new AmberClient("token", { fetchFn, sleepFn });

    const intervals = await client.getCurrentPrices("site-1");
    expect(intervals.length).toBe(1);
    expect(calls.length).toBe(2);
    expect(sleepCalls).toEqual([2000]);
  });

  test("a 500 is retried once with a default backoff when no header is present", async () => {
    const good = makeRawInterval();
    const { fetchFn, calls } = makeFetchQueue([jsonResponse([], { status: 500 }), jsonResponse([good])]);
    const sleepCalls: number[] = [];
    const client = new AmberClient("token", { fetchFn, sleepFn: async (ms) => void sleepCalls.push(ms) });

    const intervals = await client.getCurrentPrices("site-1");
    expect(intervals.length).toBe(1);
    expect(calls.length).toBe(2);
    expect(sleepCalls.length).toBe(1);
  });

  test("a 429 that persists after the single retry throws AmberRateLimitError", async () => {
    const { fetchFn, calls } = makeFetchQueue([
      jsonResponse([], { status: 429, headers: { "Retry-After": "1" } }),
      jsonResponse([], { status: 429, headers: { "Retry-After": "1" } }),
    ]);
    const client = new AmberClient("token", { fetchFn, sleepFn: noSleep() });

    await expect(client.getCurrentPrices("site-1")).rejects.toThrow(AmberRateLimitError);
    expect(calls.length).toBe(2);
  });

  test("a non-retryable 401 throws a typed AmberApiError with no retry", async () => {
    const { fetchFn, calls } = makeFetchQueue([jsonResponse({ message: "bad token" }, { status: 401 })]);
    const client = new AmberClient("token", { fetchFn, sleepFn: noSleep() });

    await expect(client.getCurrentPrices("site-1")).rejects.toThrow(AmberApiError);
    expect(calls.length).toBe(1);
  });
});

describe("AmberClient requests", () => {
  test("getCurrentPrices defaults to next=288, previous=12, resolution=5", async () => {
    const { fetchFn, calls } = makeFetchQueue([jsonResponse([])]);
    const client = new AmberClient("secret-token", { fetchFn, sleepFn: noSleep() });

    await client.getCurrentPrices("site-1");
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/sites/site-1/prices/current");
    expect(url.searchParams.get("next")).toBe("288");
    expect(url.searchParams.get("previous")).toBe("12");
    expect(url.searchParams.get("resolution")).toBe("5");

    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret-token");
  });

  test("getPrices sends startDate/endDate/resolution", async () => {
    const { fetchFn, calls } = makeFetchQueue([jsonResponse([])]);
    const client = new AmberClient("token", { fetchFn, sleepFn: noSleep() });

    await client.getPrices("site-1", "2024-01-01", "2024-01-07", 30);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/sites/site-1/prices");
    expect(url.searchParams.get("startDate")).toBe("2024-01-01");
    expect(url.searchParams.get("endDate")).toBe("2024-01-07");
    expect(url.searchParams.get("resolution")).toBe("30");
  });

  test("getUsage sends startDate/endDate and normalises Usage rows", async () => {
    const usage = {
      type: "Usage",
      channelIdentifier: "E1",
      kwh: -3.2,
      quality: "billable",
      cost: -45,
      duration: 30,
      spotPerKwh: 5,
      perKwh: 20,
      date: "2024-01-01",
      nemTime: "2024-01-01T00:30:00+10:00",
      renewables: 60,
      channelType: "feedIn",
      tariffInformation: null,
      spikeStatus: "none",
      descriptor: "neutral",
    };
    const { fetchFn, calls } = makeFetchQueue([jsonResponse([usage])]);
    const client = new AmberClient("token", { fetchFn, sleepFn: noSleep() });

    const rows = await client.getUsage("site-1", "2024-01-01", "2024-01-01");
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/sites/site-1/usage");
    expect(url.searchParams.get("startDate")).toBe("2024-01-01");
    expect(url.searchParams.get("endDate")).toBe("2024-01-01");

    expect(rows.length).toBe(1);
    expect(rows[0]?.kwh).toBe(-3.2);
    expect(rows[0]?.cost).toBe(-45);
    expect(rows[0]?.channelIdentifier).toBe("E1");
  });

  test("getSites parses sites, tolerating an unrecognised status value", async () => {
    const site = {
      id: "01F5A5CRKMZ5BCX9P1S4V990AM",
      nmi: "NMI1234567",
      channels: [{ identifier: "E1", type: "general", tariff: "A100" }],
      network: "Jemena",
      status: "somethingNew",
      intervalLength: 5,
    };
    const { fetchFn } = makeFetchQueue([jsonResponse([site])]);
    const client = new AmberClient("token", { fetchFn, sleepFn: noSleep() });

    const sites = await client.getSites();
    expect(sites.length).toBe(1);
    expect(sites[0]?.status).toBe("somethingNew");
  });
});
