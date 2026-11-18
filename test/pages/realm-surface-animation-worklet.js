// The animation worklet of the realm-surface suite (a Chrome with the
// AnimationWorklet blink feature on). Its global scope runs on a thread of
// its own and has no way to send anything but its console, which reaches
// no page: the record leaves as console lines the suite reads from the
// worklet's DevTools target (natively and through the proxy alike).
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
				`realm-surface-animation ${id} ${i} ${parts} ${text.slice(i * SIZE, (i + 1) * SIZE)}`,
			);
	};
	walker.walkSettled(globalThis, {}).then(
		(result) => emit({ lines: walker.lines(result), counts: result.counts }),
		(error) => emit({ error: String(error?.stack ?? error) }),
	);
}

registerAnimator(
	'realm-surface',
	class {
		animate(currentTime, effect) {
			effect.localTime = currentTime;
		}
	},
);
