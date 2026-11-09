// The request headers the synchronous bridge sends to the service worker,
// as a plain record (they travel as JSON): from a Headers of any realm (an
// about:blank child's own, which `instanceof Headers` in this bundle does
// not recognise), a list of pairs, or a record. None: undefined.
export function headersRecord(
	headers: HeadersInit | null | undefined,
): Record<string, string> | undefined {
	if (headers === null || headers === undefined) return undefined;
	const record: Record<string, string> = {};
	const each = (headers as { forEach?: unknown }).forEach;
	if (typeof each === 'function' && !Array.isArray(headers)) {
		// a Headers: its own iteration joins repeated names as fetch does
		(headers as Headers).forEach((value, name) => (record[name] = value));
		return record;
	}
	const pairs = Array.isArray(headers)
		? headers
		: Object.entries(headers as Record<string, string>);
	for (const [name, value] of pairs) {
		const key = String(name).toLowerCase();
		record[key] = key in record ? `${record[key]}, ${value}` : String(value);
	}
	return record;
}
