// WMO weather interpretation codes as used by Open-Meteo's `weather_code` field.
// Maps each code to a short label and an emoji; a few day/clear codes get a
// night variant chosen via `is_day`.
export interface WeatherInfo {
  label: string;
  icon: string;
}

const CODES: Record<
  number,
  { label: string; icon: string; nightIcon?: string }
> = {
  0: { label: "Clear sky", icon: "☀️", nightIcon: "🌙" },
  1: { label: "Mainly clear", icon: "🌤️", nightIcon: "🌙" },
  2: { label: "Partly cloudy", icon: "⛅", nightIcon: "☁️" },
  3: { label: "Overcast", icon: "☁️" },
  45: { label: "Fog", icon: "🌫️" },
  48: { label: "Rime fog", icon: "🌫️" },
  51: { label: "Light drizzle", icon: "🌦️" },
  53: { label: "Drizzle", icon: "🌦️" },
  55: { label: "Dense drizzle", icon: "🌧️" },
  56: { label: "Freezing drizzle", icon: "🌧️" },
  57: { label: "Freezing drizzle", icon: "🌧️" },
  61: { label: "Light rain", icon: "🌦️" },
  63: { label: "Rain", icon: "🌧️" },
  65: { label: "Heavy rain", icon: "🌧️" },
  66: { label: "Freezing rain", icon: "🌧️" },
  67: { label: "Freezing rain", icon: "🌧️" },
  71: { label: "Light snow", icon: "🌨️" },
  73: { label: "Snow", icon: "🌨️" },
  75: { label: "Heavy snow", icon: "❄️" },
  77: { label: "Snow grains", icon: "🌨️" },
  80: { label: "Light showers", icon: "🌦️" },
  81: { label: "Showers", icon: "🌧️" },
  82: { label: "Violent showers", icon: "⛈️" },
  85: { label: "Snow showers", icon: "🌨️" },
  86: { label: "Heavy snow showers", icon: "❄️" },
  95: { label: "Thunderstorm", icon: "⛈️" },
  96: { label: "Thunderstorm, hail", icon: "⛈️" },
  99: { label: "Thunderstorm, hail", icon: "⛈️" },
};

export function weatherInfo(code: number, isDay = true): WeatherInfo {
  const entry = CODES[code];
  if (!entry) return { label: "Unknown", icon: "❓" };
  return {
    label: entry.label,
    icon: !isDay && entry.nightIcon ? entry.nightIcon : entry.icon,
  };
}
