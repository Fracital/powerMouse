// A module of the performance fixture: one static import, one dynamic.
import './perf-dep.js';

const run = new URL(import.meta.url).searchParams.get('run');
globalThis.__perfDynamic = import(`./perf-dyn.js?run=${run}`);
