// The layout worklet of the realm-surface suite (a Chrome with the
// CSSLayoutAPI blink feature on). Like a paint worklet's, its global scope
// has no way to send anything but its console: the record leaves as console
// lines, which the suite collects (natively and through the proxy alike).
import './realm-walker.js';

{
	const walker = globalThis.__realmWalker;
	const emit = (report) => {
		const text = JSON.stringify(report);
		const SIZE = 60000;
		const id = `${Math.random()}`.slice(2);
		const parts = Math.ceil(text.length / SIZE);
		for (let i = 0; i < parts; i++)
			console.log(
				`realm-surface-layout ${id} ${i} ${parts} ${text.slice(i * SIZE, (i + 1) * SIZE)}`,
			);
	};
	walker.walkSettled(globalThis, {}).then(
		(result) => emit({ lines: walker.lines(result), counts: result.counts }),
		(error) => emit({ error: String(error?.stack ?? error) }),
	);
}

registerLayout(
	'realm-surface',
	class {
		static get inputProperties() {
			return [];
		}
		async intrinsicSizes() {
			return {};
		}
		async layout() {
			return {};
		}
	},
);
