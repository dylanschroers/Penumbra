import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWeather, getWeatherTool } from "./weather";

// The failure paths matter more than the happy one here. This is the only tool
// that leaves the machine, and it runs on the tier whose point is working
// without a network — so "offline" and "no such place" have to come back as
// sentences the model can relay, not as thrown errors that reach the user as
// "Tool get_weather failed: TimeoutError".

const geocode = (results: unknown[]) => ({ results });
const forecast = (current: Record<string, unknown>) => ({ current });

/** Answer the geocode call then the forecast call, in that order. */
function mockFetch(...bodies: unknown[]): void {
  const fetchMock = vi.fn();
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => body,
    } as Response);
  }
  vi.stubGlobal("fetch", fetchMock);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("get_weather contract", () => {
  it("is a read tool — it changes nothing", () => {
    expect(getWeatherTool.permission).toBe("read");
  });

  it("rejects an empty location before any request is made", () => {
    expect(getWeatherTool.args.safeParse({ location: "" }).success).toBe(false);
  });
});

describe("fetchWeather", () => {
  it("reports conditions with the geocoder's spelling of the place", async () => {
    mockFetch(
      geocode([
        {
          name: "Vancouver",
          latitude: 49.25,
          longitude: -123.12,
          admin1: "British Columbia",
          country: "Canada",
        },
      ]),
      forecast({
        temperature_2m: 14.4,
        apparent_temperature: 11.2,
        weather_code: 61,
        wind_speed_10m: 12.2,
      }),
    );

    const out = await fetchWeather({ location: "vancouver" });
    expect(out).toBe(
      "Vancouver, British Columbia, Canada: 14°C (58°F), light rain, feels like 11°C (52°F), wind 12 km/h.",
    );
  });

  it("omits 'feels like' when it rounds to the same temperature", async () => {
    mockFetch(
      geocode([{ name: "Paris", latitude: 48.85, longitude: 2.35 }]),
      forecast({
        temperature_2m: 20.1,
        apparent_temperature: 20.4,
        weather_code: 0,
      }),
    );
    const out = await fetchWeather({ location: "Paris" });
    expect(out).toBe("Paris: 20°C (68°F), clear.");
  });

  // An unknown code must not become an invented condition — the temperature is
  // still true, the description would not be.
  it("drops the condition it cannot name rather than guessing", async () => {
    mockFetch(
      geocode([{ name: "Lima", latitude: -12, longitude: -77 }]),
      forecast({ temperature_2m: 18, weather_code: 4242 }),
    );
    expect(await fetchWeather({ location: "Lima" })).toBe("Lima: 18°C (64°F).");
  });

  it("says so when the geocoder knows no such place", async () => {
    mockFetch(geocode([]));
    expect(await fetchWeather({ location: "Atlantis" })).toBe(
      'No place called "Atlantis" was found.',
    );
  });

  // The bug this pins: a service that answers and refuses is not a missing
  // network, and saying so sends the user to check their wi-fi for nothing.
  it("reports an HTTP failure as the service answering", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 429 } as Response),
    );
    expect(await fetchWeather({ location: "Berlin" })).toBe(
      "Could not reach the weather service — it answered 429.",
    );
  });

  it("names a missing network rather than throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    expect(await fetchWeather({ location: "Berlin" })).toBe(
      "Could not reach the weather service — there may be no network connection.",
    );
  });

  it("distinguishes a timeout from being offline", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout));
    expect(await fetchWeather({ location: "Berlin" })).toBe(
      "Could not reach the weather service — it did not respond in time.",
    );
  });

  it("reports an empty forecast rather than a blank answer", async () => {
    mockFetch(
      geocode([{ name: "Oslo", latitude: 59.9, longitude: 10.7 }]),
      forecast({}),
    );
    expect(await fetchWeather({ location: "Oslo" })).toBe(
      'The weather service returned no conditions for "Oslo".',
    );
  });
});
