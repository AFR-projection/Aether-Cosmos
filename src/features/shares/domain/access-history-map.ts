export function buildGoogleMapsUrl(lat: number, lon: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const query = encodeURIComponent(`${lat},${lon}`);
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}
