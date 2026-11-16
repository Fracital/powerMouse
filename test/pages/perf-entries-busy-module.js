// A module of the entry-type fixture that keeps the thread for 80 ms while
// it is evaluated.
const until = performance.now() + 80;
while (performance.now() < until);
(globalThis.__perfBusy ??= []).push('module');
