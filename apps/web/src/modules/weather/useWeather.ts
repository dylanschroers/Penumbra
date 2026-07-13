import { useCallback, useEffect, useState } from "react";

// Weather is Plane B data (docs/ARCHITECTURE.md): truth lives at the provider,
// online-only. We fetch live and cache the last result in localStorage so the
// tile restores instantly and shows last-known values (marked stale) when
// offline. API calls go straight to Open-Meteo (no key) for now; this would
// graduate to the server's Integrations module once that exists.

export type Units = "metric" | "imperial";

export interface DailyForecast {
  date: string;
  code: number;
  max: number;
  min: number;
}

export interface WeatherData {
  place: string;
  latitude: number;
  longitude: number;
  current: {
    temp: number;
    apparentTemp: number;
    code: number;
    isDay: boolean;
    wind: number;
    humidity: number;
  };
  daily: DailyForecast[];
  units: { temp: string; wind: string }; // display labels from the API response
  fetchedAt: number; // epoch ms
}

const STORAGE_KEY = "ghost.weather.v1";
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

interface Persisted {
  units: Units;
  data: WeatherData | null;
}

function defaultUnits(): Units {
  // Imperial is used mainly in the US; default from the browser's region.
  try {
    return new Intl.Locale(navigator.language).region === "US"
      ? "imperial"
      : "metric";
  } catch {
    return "metric";
  }
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        units: parsed.units === "imperial" ? "imperial" : "metric",
        data: parsed.data ?? null,
      };
    }
  } catch {
    // Ignore unavailable/corrupt storage.
  }
  return { units: defaultUnits(), data: null };
}

function unitParams(units: Units): {
  temperature_unit: string;
  wind_speed_unit: string;
} {
  return units === "imperial"
    ? { temperature_unit: "fahrenheit", wind_speed_unit: "mph" }
    : { temperature_unit: "celsius", wind_speed_unit: "kmh" };
}

async function fetchForecast(
  lat: number,
  lon: number,
  place: string,
  units: Units,
): Promise<WeatherData> {
  const u = unitParams(units);
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current:
      "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min",
    forecast_days: "4",
    timezone: "auto",
    temperature_unit: u.temperature_unit,
    wind_speed_unit: u.wind_speed_unit,
  });
  const res = await fetch(`${FORECAST_URL}?${params.toString()}`);
  if (!res.ok) throw new Error(`Forecast request failed (${res.status})`);
  const json = await res.json();
  const c = json.current;
  const d = json.daily;
  const daily: DailyForecast[] = d.time.map((date: string, i: number) => ({
    date,
    code: d.weather_code[i],
    max: d.temperature_2m_max[i],
    min: d.temperature_2m_min[i],
  }));
  return {
    place,
    latitude: lat,
    longitude: lon,
    current: {
      temp: c.temperature_2m,
      apparentTemp: c.apparent_temperature,
      code: c.weather_code,
      isDay: c.is_day === 1,
      wind: c.wind_speed_10m,
      humidity: c.relative_humidity_2m,
    },
    daily,
    units: {
      temp: json.current_units.temperature_2m,
      wind: json.current_units.wind_speed_10m,
    },
    fetchedAt: Date.now(),
  };
}

export function useWeather() {
  const [persisted] = useState(load);
  const [units, setUnits] = useState<Units>(persisted.units);
  const [data, setData] = useState<WeatherData | null>(persisted.data);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ units, data }));
    } catch {
      // Ignore quota/serialization errors; the in-memory state still works.
    }
  }, [units, data]);

  const search = useCallback(
    async (city: string) => {
      const q = city.trim();
      if (!q) return;
      setLoading(true);
      setError(null);
      try {
        const geoParams = new URLSearchParams({
          name: q,
          count: "1",
          language: "en",
          format: "json",
        });
        const geoRes = await fetch(`${GEOCODE_URL}?${geoParams.toString()}`);
        if (!geoRes.ok) throw new Error(`Search failed (${geoRes.status})`);
        const geo = await geoRes.json();
        const top = geo.results?.[0];
        if (!top) throw new Error(`No match for "${q}"`);
        const place = [top.name, top.admin1, top.country]
          .filter(Boolean)
          .join(", ");
        setData(await fetchForecast(top.latitude, top.longitude, place, units));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [units],
  );

  const locate = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setError("Geolocation is not available.");
      return;
    }
    setLoading(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          setData(
            await fetchForecast(
              pos.coords.latitude,
              pos.coords.longitude,
              "Current location",
              units,
            ),
          );
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setLoading(false);
        }
      },
      (geoErr) => {
        setError(geoErr.message || "Couldn't get your location.");
        setLoading(false);
      },
      { timeout: 10000 },
    );
  }, [units]);

  // Switch units and refetch the current place so values come back in the new
  // system (rather than converting client-side).
  const changeUnits = useCallback(
    async (next: Units) => {
      setUnits(next);
      if (!data) return;
      setLoading(true);
      setError(null);
      try {
        setData(
          await fetchForecast(data.latitude, data.longitude, data.place, next),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [data],
  );

  return { units, data, loading, error, search, locate, changeUnits };
}
