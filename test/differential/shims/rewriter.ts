// What src/inject/rewriter.ts is to the inject's modules, for the
// differential harness (test/differential/harness.mjs): the rewrite itself is
// made in the harness's own realm by src/rewriteJS.ts with the wasm core, and
// the text a rewrite keeps for its functions' sources is kept in this realm,
// as the inject keeps it (src/functionSource.ts keepSource).
import { keepSource } from '../../../src/functionSource';

interface Host {
	/** `[output, [key, text]...]`: the rewrite and what it keeps */
	rewrite: (script: string, type: string, preamble: string) => unknown[];
	print: (source: string, part: string) => string | null;
}

let host: Host | null = null;
export function useHost(given: Host) {
	host = given;
}

export function modifyJS(
	script: string,
	_url: unknown,
	_config: unknown,
	type = 'generic',
	preamble = '',
): string {
	const [output, ...kept] = host!.rewrite(
		String(script),
		String(type),
		String(preamble),
	);
	for (const entry of kept) {
		const [key, text] = entry as [string, string];
		keepSource(String(key), String(text));
	}
	return String(output);
}

export function printExpression(source: string, part: string): string | null {
	const printed = host!.print(String(source), String(part));
	return printed === null ? null : String(printed);
}
