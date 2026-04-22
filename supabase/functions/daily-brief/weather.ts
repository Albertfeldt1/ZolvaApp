const USER_AGENT = 'Zolva/1.0 Kontakt@zolva.io';

export type Weather = {
  tempC: number;
  highC: number;
  lowC: number;
  conditionLabel: string;
};

const CONDITION_LABELS: Record<string, string> = {
  clearsky: 'Klart vejr',
  fair: 'Fint vejr',
  partlycloudy: 'Delvist skyet',
  cloudy: 'Skyet',
  rainshowers: 'Regnbyger',
  rain: 'Regn',
  heavyrain: 'Kraftig regn',
  snow: 'Sne',
  fog: 'Tåge',
};

function normalizeSymbol(raw: string): string {
  return raw.replace(/_(day|night|polartwilight)$/, '').replace(/_/g, '').toLowerCase();
}

// 30-minute cache keyed by rounded lat/lng to stay well under Met.no's rate.
const cache = new Map<string, { value: Weather; expiresAt: number }>();

export async function fetchWeather(lat: number, lng: number): Promise<Weather | null> {
  const key = `${lat.toFixed(2)}:${lng.toFixed(2)}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lng}`;
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      properties: {
        timeseries: Array<{
          time: string;
          data: {
            instant: { details: { air_temperature: number } };
            next_1_hours?: { summary: { symbol_code: string } };
            next_6_hours?: { details: { air_temperature_max: number; air_temperature_min: number } };
          };
        }>;
      };
    };
    const series = data.properties?.timeseries ?? [];
    if (series.length === 0) return null;
    const now = series[0];
    const tempC = now.data.instant.details.air_temperature;
    const symbol = now.data.next_1_hours?.summary.symbol_code ?? 'cloudy';
    const label = CONDITION_LABELS[normalizeSymbol(symbol)] ?? 'Blandet vejr';
    const next6 = now.data.next_6_hours?.details;
    const highC = next6?.air_temperature_max ?? tempC;
    const lowC = next6?.air_temperature_min ?? tempC;
    const value: Weather = { tempC, highC, lowC, conditionLabel: label };
    cache.set(key, { value, expiresAt: Date.now() + 30 * 60 * 1000 });
    return value;
  } catch {
    return null;
  }
}
