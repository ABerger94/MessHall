// Tiny API client. All requests are same-origin; in dev Vite proxies /api
// to the Express server. The API key lives in localStorage (see App.jsx).

export async function api(path, { method = 'GET', key = '', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'X-API-Key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}
