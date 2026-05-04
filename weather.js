// lib/weather.js
// OpenWeather lookup, location-aware (per-user lat/lng)

const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const KEY = process.env.OPENWEATHER_KEY;
const DEFAULT_LAT = parseFloat(process.env.DBP_LOCATION_LAT || '37.2753');
const DEFAULT_LNG = parseFloat(process.env.DBP_LOCATION_LNG || '-107.8801');

async function getWeather(lat, lng) {
  if (!KEY) return null;
  const useLat = lat ?? DEFAULT_LAT;
  const useLng = lng ?? DEFAULT_LNG;
  try {
    const [currentRes, forecastRes] = await Promise.all([
      fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${useLat}&lon=${useLng}&units=imperial&appid=${KEY}`),
      fetch(`https://api.openweathermap.org/data/2.5/forecast?lat=${useLat}&lon=${useLng}&units=imperial&appid=${KEY}&cnt=4`),
    ]);
    const current = await currentRes.json();
    const forecast = await forecastRes.json();
    if (!current?.main || !current?.weather?.[0]) return null;

    const next12h = (forecast.list || []).slice(0, 4).map(f => ({
      time: new Date(f.dt * 1000).toLocaleTimeString('en-US', { hour: 'numeric' }),
      temp: Math.round(f.main.temp),
      feels_like: Math.round(f.main.feels_like),
      conditions: f.weather[0].main,
      description: f.weather[0].description,
      wind_mph: Math.round(f.wind.speed),
      wind_gust_mph: f.wind.gust ? Math.round(f.wind.gust) : null,
      precip_chance_pct: Math.round((f.pop || 0) * 100),
    }));

    return {
      current: {
        temp: Math.round(current.main.temp),
        feels_like: Math.round(current.main.feels_like),
        conditions: current.weather[0].main,
        description: current.weather[0].description,
        wind_mph: Math.round(current.wind.speed),
        humidity_pct: current.main.humidity,
      },
      next_12h: next12h,
      summary: `${Math.round(current.main.temp)}°F ${current.weather[0].description}, wind ${Math.round(current.wind.speed)}mph.`,
    };
  } catch (e) {
    console.log('[weather] failed:', e.message);
    return null;
  }
}

module.exports = { getWeather };
