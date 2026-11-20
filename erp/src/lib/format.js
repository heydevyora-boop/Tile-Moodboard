/* ============================================================
   HOW NUMBERS AND DATES ARE WRITTEN, EVERYWHERE
   ============================================================
   Indian digit grouping throughout -- 2,01,63,533, not 20,163,533
   -- because that is how the studio reads a figure, and a lakh
   written the international way is read wrong at a glance.
   ============================================================ */

/** Rupees, no paise. Stock and order values are never quoted to the
 *  paisa, and the extra two digits only make a column harder to scan. */
export function money(n) {
  return '₹' + Math.round(n || 0).toLocaleString('en-IN');
}

/** Rupees, shortened for a headline figure where the exact number
 *  belongs in the table beneath rather than in 48px type. */
export function moneyShort(n) {
  const v = Math.round(n || 0);
  if (v >= 10000000) return '₹' + (v / 10000000).toFixed(2) + ' Cr';
  if (v >= 100000) return '₹' + (v / 100000).toFixed(2) + ' L';
  if (v >= 1000) return '₹' + (v / 1000).toFixed(1) + 'k';
  return '₹' + v;
}

export function qty(n) {
  return (n || 0).toLocaleString('en-IN');
}

/** A date a person reads: 20 Nov 2026. */
export function day(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

/** A date and time, for the sync log where the minute matters. */
export function stamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' })
    + ', ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
}

/** "3 days ago", against the frozen demo clock rather than the real
 *  one, so the wording agrees with the dates beside it. */
export function since(iso, now) {
  if (!iso) return '—';
  const mins = Math.round((now.getTime() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
  const days = Math.round(hrs / 24);
  if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago');
  const months = Math.round(days / 30);
  return months + (months === 1 ? ' month ago' : ' months ago');
}
