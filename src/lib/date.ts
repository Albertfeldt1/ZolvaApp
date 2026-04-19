const WEEKDAYS_SHORT = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør'];
const WEEKDAYS_FULL = ['Søndag', 'Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag'];
const MONTHS_SHORT = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const MONTHS_FULL = ['januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'december'];
const WEEK_LETTERS = ['M', 'T', 'O', 'T', 'F', 'L', 'S'];

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function isoWeek(date: Date): number {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

export function greeting(date: Date): string {
  const h = date.getHours();
  if (h < 10) return 'Godmorgen';
  if (h < 17) return 'Goddag';
  return 'Godaften';
}

export function formatToday(date: Date) {
  const weekdayShort = cap(WEEKDAYS_SHORT[date.getDay()]);
  const weekdayFull = WEEKDAYS_FULL[date.getDay()];
  const monthShort = MONTHS_SHORT[date.getMonth()];
  const monthFull = MONTHS_FULL[date.getMonth()];
  const day = date.getDate();
  const week = isoWeek(date);
  return {
    weekdayShort,
    weekdayFull,
    day,
    monthShort,
    monthFull,
    week,
    eyebrow: `${weekdayShort} · ${day} ${monthShort} · Uge ${week}`,
    dayHeadline: weekdayFull,
    weekHeadline: `Uge ${week} · ${monthFull}`,
  };
}

export function formatClock(date: Date): string {
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${h}.${m}`;
}

export function weekStrip(today: Date) {
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return {
      letter: WEEK_LETTERS[i],
      num: d.getDate(),
      isToday:
        d.getFullYear() === today.getFullYear() &&
        d.getMonth() === today.getMonth() &&
        d.getDate() === today.getDate(),
    };
  });
}
