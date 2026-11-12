import { z } from "zod";
import type { ToolContract } from "./contract";

// Contract and runner together, unlike the other tools: it touches no store, so
// both tiers share one implementation. Open-Meteo needs no key and sends CORS
// headers, so Tier 0 can call it from the webview.

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

/** Short so an offline machine gets an answer instead of a hang. */
const REQUEST_TIMEOUT_MS = 5000;

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

/** Unknown codes fall through to temperature only, never an invented condition. */
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

/** Lets the caller tell "the service refused" from "nothing answered". */
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

/** Both units rather than a `units` argument: one fewer slot for the model. */
const temperature = (c: number): string =>
  `${round(c)}°C (${round((c * 9) / 5 + 32)}°F)`;

/** Never throws: failures are ordinary answers for the model to relay. */
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

  // The geocoder's spelling is more trustworthy than the model's.
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
