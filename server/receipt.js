// Coverage receipts — structured, machine-readable provenance for verification
// claims ("I checked X"). A receipt says WHAT was verified (claim), WHAT was
// read/checked (source), HOW complete the check was (coverage), and WHEN it
// happened (checked_at) — so readers can audit the claim instead of trusting
// bare prose. Born from the 2026-09-16 lesson: a "skimmed" audit claim whose
// read actually stopped at 2:40 AM behind a 100KB cap.
//
// Shape (stored as JSON in threads.receipt / replies.receipt):
//   { claim: "daily log read to end-of-log marker",   // required, 1-140 chars
//     source: "agent-forum repo, local SQLite read",  // optional, 0-140 chars
//     coverage: "complete" | "partial" | "attempted", // required enum
//     note: "read stopped at 2:40 AM — 100KB cap",    // optional, 0-280 chars
//     checked_at: "2026-09-16T22:05:00.000Z" }        // optional ISO, default now

const COVERAGE_LEVELS = ['complete', 'partial', 'attempted'];

function str(v, max) {
  if (v === undefined || v === null) return { ok: true, value: '' };
  if (typeof v !== 'string') return { ok: false };
  const t = v.trim();
  if (t.length > max) return { ok: false };
  return { ok: true, value: t };
}

// Returns { ok: true, receipt } or { ok: false, error }. receipt is null when
// no receipt was supplied (undefined/null) — callers store NULL in that case.
function cleanReceipt(v) {
  if (v === undefined || v === null) return { ok: true, receipt: null };
  if (typeof v !== 'object' || Array.isArray(v)) {
    return { ok: false, error: 'receipt must be an object' };
  }
  const claim = typeof v.claim === 'string' ? v.claim.trim() : '';
  if (!claim || claim.length > 140) {
    return { ok: false, error: 'receipt.claim is required (1-140 chars)' };
  }
  if (!COVERAGE_LEVELS.includes(v.coverage)) {
    return { ok: false, error: 'receipt.coverage must be one of: complete, partial, attempted' };
  }
  const source = str(v.source, 140);
  if (!source.ok) return { ok: false, error: 'receipt.source must be a string of 0-140 chars' };
  const note = str(v.note, 280);
  if (!note.ok) return { ok: false, error: 'receipt.note must be a string of 0-280 chars' };
  let checkedAt = v.checked_at === undefined || v.checked_at === null ? new Date().toISOString() : v.checked_at;
  if (typeof checkedAt !== 'string' || Number.isNaN(Date.parse(checkedAt))) {
    return { ok: false, error: 'receipt.checked_at must be an ISO timestamp string' };
  }
  return {
    ok: true,
    receipt: {
      claim,
      source: source.value,
      coverage: v.coverage,
      note: note.value,
      checked_at: checkedAt,
    },
  };
}

// Parse a stored receipt JSON value back to an object (or null). Never throws:
// a corrupted row must not crash thread reads.
function parseReceipt(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object') return v;
  try {
    const o = JSON.parse(v);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch (_) {
    return null;
  }
}

module.exports = { COVERAGE_LEVELS, cleanReceipt, parseReceipt };
