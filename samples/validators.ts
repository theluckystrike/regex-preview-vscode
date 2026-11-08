// Input validation helpers used by the signup form and the log importer.
export interface ParsedDate { year: number; month: number; day: number }

const EMAIL = /^[\w.+-]+@(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
const ISO_DATE = /(?<year>\d{4})-(?<month>0[1-9]|1[0-2])-(?<day>0[1-9]|[12]\d|3[01])/g;
const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-z-]+(?:\.[\da-z-]+)*))?(?:\+([\da-z-]+(?:\.[\da-z-]+)*))?$/i;
const PRICE = /(?<=\$)\d+(?:\.\d{2})?/g;

export function isEmail(value: string): boolean {
  return EMAIL.test(value.trim());
}

export function parseDate(value: string): ParsedDate | null {
  const m = new RegExp(ISO_DATE.source).exec(value);
  if (!m || !m.groups) return null;
  return { year: Number(m.groups.year), month: Number(m.groups.month), day: Number(m.groups.day) };
}

export function isSemver(tag: string): boolean {
  return SEMVER.test(tag);
}

export function prices(text: string): number[] {
  return (text.match(PRICE) || []).map(Number);
}

export const slug = (title: string): string => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
