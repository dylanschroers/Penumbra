import { useState, type FormEvent } from "react";
import { useWeather } from "./useWeather";
import { weatherInfo } from "./weatherCodes";

function relativeTime(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
  });
}

// Weather module: search a city (or use geolocation), see current conditions and
// a 3-day forecast. Units auto-default from locale with a toggle; the last result
// is cached so it restores on reload. State and fetching live in useWeather.
export function WeatherModule() {
  const { units, data, loading, error, search, locate, changeUnits } =
    useWeather();
  const [city, setCity] = useState("");

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void search(city);
  }

  const now = data?.current;
  const info = now ? weatherInfo(now.code, now.isDay) : null;

  return (
    <div className="weather">
      <form className="weather__search" onSubmit={onSubmit}>
        <input
          className="weather__input"
          placeholder="Search city…"
          value={city}
          onChange={(e) => setCity(e.target.value)}
          aria-label="City"
        />
        <button
          type="submit"
          className="btn btn--primary"
          disabled={loading || !city.trim()}
        >
          Go
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => locate()}
          disabled={loading}
          title="Use my location"
          aria-label="Use my location"
        >
          📍
        </button>
      </form>

      {error && <p className="notice notice--error">{error}</p>}

      {!data && !error && (
        <p className="notice">
          {loading ? "Loading…" : "Search a city to see the weather."}
        </p>
      )}

      {data && now && info && (
        <>
          <div className="weather__place">{data.place}</div>
          <div className="weather__current">
            <span className="weather__icon" aria-hidden="true">
              {info.icon}
            </span>
            <span className="weather__temp">
              {Math.round(now.temp)}
              {data.units.temp}
            </span>
            <span className="weather__label">{info.label}</span>
          </div>
          <div className="weather__metrics">
            <span>
              Feels {Math.round(now.apparentTemp)}
              {data.units.temp}
            </span>
            <span>
              Wind {Math.round(now.wind)} {data.units.wind}
            </span>
            <span>Humidity {now.humidity}%</span>
          </div>
          <ul className="weather__forecast">
            {data.daily.slice(1, 4).map((day) => (
              <li key={day.date} className="weather__day">
                <span className="weather__day-name">{dayLabel(day.date)}</span>
                <span className="weather__day-icon" aria-hidden="true">
                  {weatherInfo(day.code).icon}
                </span>
                <span className="weather__day-temps">
                  {Math.round(day.max)}° / {Math.round(day.min)}°
                </span>
              </li>
            ))}
          </ul>
          <div className="weather__footer">
            <span className="weather__updated">
              Updated {relativeTime(data.fetchedAt)}
              {!navigator.onLine ? " · offline" : ""}
            </span>
            <button
              type="button"
              className="btn btn--ghost weather__units"
              onClick={() =>
                void changeUnits(units === "metric" ? "imperial" : "metric")
              }
              disabled={loading}
            >
              {units === "metric" ? "°F" : "°C"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
