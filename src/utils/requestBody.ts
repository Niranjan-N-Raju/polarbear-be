export function bodyTooLarge(requestBody: unknown, limit: number): boolean {
  return Buffer.byteLength(JSON.stringify(requestBody ?? {}), 'utf8') > limit;
}
