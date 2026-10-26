export const MAX_SEARCH_LENGTH = 100;
// Deep skip() offsets force MongoDB to walk and discard every preceding document.
export const MAX_PAGE = 10_000;

export const SEARCH_TOO_LONG_MESSAGE = `Search must be ${MAX_SEARCH_LENGTH} characters or fewer.`;

export function isSearchTooLong(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > MAX_SEARCH_LENGTH;
}

export function clampPage(page: number): number {
  return Math.min(MAX_PAGE, page);
}
