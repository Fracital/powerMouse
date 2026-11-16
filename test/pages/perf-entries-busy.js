// A classic script of the entry-type fixture that keeps the thread for
// 80 ms while it runs: a long animation frame names it as its script.
{
	const until = performance.now() + 80;
	while (performance.now() < until);
	(globalThis.__perfBusy ??= []).push('classic');
}
