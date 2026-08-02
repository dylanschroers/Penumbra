import { z } from "zod";
import type { ToolContract } from "./contract";

// The weather tool: contract *and* runner, which is the one exception to the
// rule stated in contract.ts that implementations live per-runtime.
//
// That rule exists because a tool's `run` is platform-bound — the task tools
// reach a store that is the browser's IndexedDB on Tier 0 and the server's
// SQLite on Tier 1, so there is no one implementation to share. This tool
// touches no store at all. It is a `fetch` and some formatting, identical on
// both tiers, and duplicating it would mean two copies of a WMO code table
// drifting apart. So the contract's runner ships beside it and each runtime
// binds the same function.
//
// Open-Meteo is the provider because it needs no API key and sends CORS headers:
// the first keeps "Penumbra holds no third-party credentials at all"
// (docs/ARCHITECTURE.md → Security & privacy) true, and the second is what lets
// Tier 0 call it from the webview at all.

export const getWeatherTool = {
  name: "get_weather",
  description:
    "Look up the current weather for a city or place. Use for questions " +
    "about weather, temperature, or conditions right now.",
  permission: "read",
  args: z.object({
    location: z
      .string()
      .min(1)
      .max(200)
      .describe("City or place name, e.g. 'Vancouver' or 'Paris, France'"),
  }),
} satisfies ToolContract;

/** The tool's whole network budget, per call. Generous enough for a geocode and
 *  a forecast over a slow link, short enough that an offline machine gets an
 *  answer rather than a hang — this is the tier whose point is working without
 *  a network, so failing fast is a feature. */
const REQUEST_TIMEOUT_MS = 5000;

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

/** WMO weather interpretation codes, which is what Open-Meteo reports instead
 *  of a description. Only the codes it documents; anything else falls through
 *  to the temperature alone rather than inventing a condition. */
const WEATHER_CODES: Record<number, string> = {
  0: "clear",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "foggy",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "light freezing drizzle",
  57: "freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "light freezing rain",
  67: "freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light rain showers",
  81: "rain showers",
  82: "heavy rain showers",
  85: "light snow showers",
  86: "snow showers",
  95: "thunderstorms",
  96: "thunderstorms with hail",
  99: "thunderstorms with heavy hail",
};

interface GeocodeResult {
  name?: string;
  latitude?: number;
  longitude?: number;
  country?: string;
  admin1?: string;
}

interface CurrentWeather {
  temperature_2m?: number;
  apparent_temperature?: number;
  weather_code?: number;
  wind_speed_10m?: number;
}

/**
 * A non-2xx from the weather service, carrying the status.
 *
 * Typed so the caller can tell "it answered and refused" from "nothing
 * answered" — the distinction StudioHttpError draws for the same reason.
 * Collapsed into a plain Error, every HTTP failure read as a missing network
 * connection, which sends someone to check their wi-fi while the connection is
 * fine and the service is rate-limiting them.
 */
class WeatherHttpError extends Error {
  constructor(readonly status: number) {
    super(`weather service responded ${status}`);
    this.name = "WeatherHttpError";
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new WeatherHttpError(res.status);
  return (await res.json()) as T;
}

const round = (n: number): number => Math.round(n);

/** Celsius with Fahrenheit alongside. Both, rather than a `units` argument: an
 *  extra enum is one more slot for a small model to fill wrong, and the answer
 *  is short enough to carry both for whoever is reading. */
const temperature = (c: number): string =>
  `${round(c)}°C (${round((c * 9) / 5 + 32)}°F)`;

/**
 * Look up current conditions, as a sentence for the model to relay.
 *
 * Returns a message on every failure rather than throwing. `runTool` would
 * catch a throw and format it as "Tool get_weather failed: …", which reads to
 * the model as a bug rather than as an answer it can pass on — "no network" and
 * "no such place" are both ordinary outcomes here and deserve plain wording.
 */
export async function fetchWeather(args: {
  location: string;
}): Promise<string> {
  const query = args.location.trim();

  let place: GeocodeResult | undefined;
  let current: CurrentWeather | undefined;
  try {
    const geo = await getJson<{ results?: GeocodeResult[] }>(
      `${GEOCODE_URL}?${new URLSearchParams({
        name: query,
        count: "1",
        language: "en",
        format: "json",
      })}`,
    );
    place = geo.results?.[0];
    // A place the geocoder does not know is not an error: say so and stop,
    // rather than reporting the weather somewhere the user did not ask about.
    if (place?.latitude === undefined || place.longitude === undefined) {
      return `No place called "${query}" was found.`;
    }

    const forecast = await getJson<{ current?: CurrentWeather }>(
      `${FORECAST_URL}?${new URLSearchParams({
        latitude: String(place.latitude),
        longitude: String(place.longitude),
        current:
          "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
      })}`,
    );
    current = forecast.current;
  } catch (err) {
    // Three outcomes, three different things to do about them. Offline is the
    // expected case on the tier this matters for, so it is worth naming rather
    // than surfacing a DOMException — but only when it is actually what
    // happened.
    const reason =
      err instanceof WeatherHttpError
        ? `it answered ${err.status}`
        : err instanceof Error && err.name === "TimeoutError"
          ? "it did not respond in time"
          : "there may be no network connection";
    return `Could not reach the weather service — ${reason}.`;
  }

  if (current?.temperature_2m === undefined) {
    return `The weather service returned no conditions for "${query}".`;
  }

  // Region and country disambiguate the many Springfields, and the geocoder's
  // spelling of the name is more trustworthy than the model's.
  const label = [place.name ?? query, place.admin1, place.country]
    .filter(Boolean)
    .join(", ");

  const parts = [temperature(current.temperature_2m)];
  const condition =
    current.weather_code === undefined
      ? undefined
      : WEATHER_CODES[current.weather_code];
  if (condition) parts.push(condition);
  if (
    current.apparent_temperature !== undefined &&
    round(current.apparent_temperature) !== round(current.temperature_2m)
  ) {
    parts.push(`feels like ${temperature(current.apparent_temperature)}`);
  }
  if (current.wind_speed_10m !== undefined) {
    parts.push(`wind ${round(current.wind_speed_10m)} km/h`);
  }

  return `${label}: ${parts.join(", ")}.`;
}
