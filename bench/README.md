# Benchmarks

This directory compares STomp with the other web proxies a person might run in its place:
[Scramjet](https://github.com/MercuryWorkshop/scramjet), [Ultraviolet](https://github.com/titaniumnetwork-dev/Ultraviolet),
and the two proxies STomp grew out of, [stompV1](https://github.com/Fracital/stompV1) and
[powerMouseV1](https://github.com/Fracital/powerMouseV1). Every contender is set up the way its own README or demo
recommends, runs in the same Chrome on the same host, and, where it can, reaches the network through the same
[holyWisp](https://github.com/Fracital/holyWisp) server with the same transport (epoxy over wisp); native Chrome with no
proxy is the reference row everywhere. The harness loads 85 real sites natively and through every proxy and scores each
load against the native ones (screenshot and text similarity, errors, a scripted interaction), times page loads on local
fixture pages and on large real sites, measures first-visit cost, single-page-app navigation, rewrite throughput, memory
and CPU, runs a neutral web-platform fidelity battery with a leak check, and weighs what each proxy ships. All page
measurements are read from an isolated world, so no proxy's hooks are in the way of the harness.

None of this runs as part of `npm test` or CI. It is a tool for development.

The last full run's tables are in [RESULTS.md](RESULTS.md) and its charts (PNG) in `charts/`, in light and dark variants;
the root README embeds four of them. Fresh runs land in `results/`, which git ignores. To refresh the committed copies
after a run:

```sh
cp bench/results/full/charts/*.png bench/charts/
```

and rebuild `RESULTS.md` from `results/full/results.md` plus the host and version notes at its top.

## What is here

| File                                                                       | Purpose                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.py`                                                                   | The entry point (`npm run bench`). Sets up every contender at its pinned version, then runs the driver, which starts holyWisp, the harness DNS, the fixture servers, the leak catcher, every contender's host server and Chrome, takes the measurements and writes `results.json`, `runs.jsonl`, `results.csv` and `results.md`. |
| `charts.py`                                                                | Reads a results directory and produces `charts/*.svg` (add `--png` for PNGs too), in light and `-dark` variants, plus `report.html` (every chart with its table) and `contact-sheet.html` (every site-support screenshot). Standard library only.                                                                                |
| `configs/`                                                                 | One file per contender with its exact setup: pinned version and sources, URL prefix, codec, transport and its version, service worker, flags, headers, and every choice that could help or hurt it. The adapters read them.                                                                                                      |
| `contenders/<id>/`                                                         | How a contender is installed (`setup`), described, started and served (`adapter.mjs`), and its host page (`host/`): one proxied frame filling the viewport and nothing else.                                                                                                                                                     |
| `lib/driver.mjs`                                                           | The measuring driver `run.py` starts (Node, Playwright on Chrome).                                                                                                                                                                                                                                                               |
| `lib/setup.mjs`                                                            | Clones, downloads, installs and builds the contenders into `bench/.contenders/` (git ignores it).                                                                                                                                                                                                                                |
| `lib/holywisp.mjs`, `lib/dns.mjs`, `lib/leak.mjs`, `lib/node-dns-shim.cjs` | The shared network: holyWisp's command line, the DNS that gives the fixtures real names, the catcher that counts requests bypassing a proxy, and the name mapping for the two contenders that fetch from Node.                                                                                                                   |
| `lib/browser.mjs`, `lib/probe.js`, `lib/session.mjs`                       | Chrome's flags, the probe that runs in an isolated world of every document, and one measured load.                                                                                                                                                                                                                               |
| `lib/site-support.mjs`, `lib/interact.mjs`, `lib/sites.mjs`                | The site-support scenario, its scripted interactions and the 85-site corpus.                                                                                                                                                                                                                                                     |
| `lib/speed.mjs`, `lib/metrics.mjs`                                         | Fixture and real-site loads, first visit, single-page app, memory; Chrome and server CPU and memory counters.                                                                                                                                                                                                                    |
| `lib/rewrite-offline.mjs`, `lib/scripts.mjs`                               | Each rewriter alone on the script corpus (10 real libraries, 15 MB, pinned by version and sha256).                                                                                                                                                                                                                               |
| `lib/fidelity.mjs`                                                         | The fidelity battery and the leak vectors.                                                                                                                                                                                                                                                                                       |
| `lib/size.mjs`, `lib/report.mjs`, `lib/stats.mjs`, `lib/similarity.mjs`    | Shipped bytes; `results.md`/`results.csv`; medians, spreads and run order; SSIM and text overlap.                                                                                                                                                                                                                                |
| `lib/dev-drive.mjs`                                                        | Loads one URL through one row and prints what the harness sees, for working on an adapter.                                                                                                                                                                                                                                       |
| `fixtures/`                                                                | Local pages: `speed/` (an article, 200 subresources, a single-page app, ad-like frames), `rewrite/` (the script corpus page), `fidelity/` (the battery and the leak vectors).                                                                                                                                                    |

## The contenders

- `stomp-js`, `stomp-wasm`, `stomp-noadblock` are this checkout (its `dist/`, from `npm ci && npm run build`), set up
  as `demo/public/pm/main.js` sets it up when opened on 127.0.0.1: the same-origin `StompController`, the service
  worker at `/stomp/`, the xor codec, its HTTP cache and emulated service workers on, epoxy from the build
  `package.json` pins (Fracital/EpoxyTransport) as a transport descriptor run in the transport worker, HTTP/3 on,
  Cloudflare DoH for ECH, and the demo server's cross-origin isolation headers. `stomp-js` is the default
  JavaScript rewriter with the content blocker on (its default), `stomp-wasm` the Rust/wasm rewriter
  (`rewriter: 'wasm'`), `stomp-noadblock` the JavaScript rewriter with `adblock: false`, the like-for-like row. With
  the blocker on, every fresh context downloads its filter lists (EasyList, uBlock Origin) through the proxy at start,
  which is what a new visitor pays.
- `scramjet` is MercuryWorkshop/scramjet `main` at 517206bc, from the tarballs its CI publishes as the "Continuous
  Build" release (tag `latest`): `@mercuryworkshop/scramjet` 2.0.67-alpha.2 and `@mercuryworkshop/scramjet-controller`
  0.0.14, checked by sha256. `scramjet-utils` (for the `HttpCachePlugin` both official setups install) is not in the
  release and its npm build expects older packages, so setup builds `packages/utils` at the same commit with esbuild.
  Transport: `@mercuryworkshop/epoxy-transport` 3.0.2 and `proxy-transports` 1.0.2, the versions the repository's pnpm
  catalog pins. Host as `packages/demo`: its `sw.js`, a `Controller` in the page, `createFrame()` and `frame.go(url)`,
  the controller's default (production) config.
- `ultraviolet` is `@titaniumnetwork-dev/ultraviolet` 3.2.10 (npm latest, GitHub release v3.2.10-headers), set up as
  the official [Ultraviolet-App](https://github.com/titaniumnetwork-dev/Ultraviolet-App) at a1762248: its `uv.config.js` values
  (generated from `configs/ultraviolet.json`; xor codec, prefix `/uv/service/`), `/uv/sw.js`, bare-mux 2.1.8 with its SharedWorker, epoxy-transport 2.1.28 (the
  app's exact pin; npm marks it deprecated for trusting revoked eMudhra roots, 2.1.29 has the fix), and the app
  server's COOP/COEP headers.
- `stompv1` is Fracital/stompV1 at 7ee94c22 (one commit after v2.0.0), built with `npm ci && npm run build`
  (webpack). It uses a Bare server, so it cannot use wisp: `@tomphttp/bare-server-node` 2.0.0 (released the day before
  stompV1 2.0.0, the first with the Bare v3 protocol its client needs) runs at `/bare/` on the host origin in a Node
  process, with `blockLocal` off to match holyWisp's loopback setting. Its demo frontend (sysce/tomp-demo) no longer
  exists; the host page does what the frontends built on it did (`StompBoot` with the xor codec, `boot.html(url)`).
- `powermouse-v1` is Fracital/powerMouseV1 at 8fdaf44d, a server-side rewriting proxy (`npm ci`, `node app.js`). It
  has no lockfile, so `contenders/powermouse-v1/package-lock.json` pins what `npm install` resolved on 2026-11-11. It
  runs from a private directory with `config.json` set to 127.0.0.1 and a free port, addressed as `localhost` (on
  127.0.0.1 its cookie domain becomes `.0.0.1:<port>`, which the current `cookie` package rejects). It proxies only
  hosts whose last label is on the public suffix list it downloads at start; the copy of `app.js` it runs appends
  `test` to that list so the `*.bench.test` fixtures load, its only code change.

Each contender's settings are in `configs/<id>.json`. Every row runs on the same Node (24 on the bench host). The exact versions, integrity hashes, commands and
configuration notes of a run are in its `results.json` under `meta.rows`.

## Running it

```sh
npm ci && npm run build                       # STomp's dist/, which its rows serve
npm run bench                                 # = python3 -I bench/run.py, results in bench/results/<date>
python3 -I bench/run.py --out bench/results/full
python3 -I bench/charts.py bench/results/full --png
```

`run.py` needs Node 22 or newer (`--node` or `BENCH_NODE`), Chrome (`--chrome` or `CHROME`; default the CI build of
Chrome 156 under `~/.cache/stomp-chrome/156/`), a holyWisp binary (`--holywisp` or `HOLYWISP`; default
`~/src/holyWisp/build/release/holywisp`, from `make release` in a holyWisp checkout), git, network access, and for the
site-support scenario a display: it runs headful Chrome and starts `Xvfb` itself when `DISPLAY` is unset (Debian:
`apt-get install xvfb`); `--headless` runs it headless instead.

The published run comes from `wispdev`, a 16-vCPU KVM guest (Xeon Gold 6348, Debian 13) that ran nothing else, with
everything under `/root/bench-proxies/`: Node 24 from the nodejs.org tarball in `opt/node24`, Chrome 156.0.8078.79
unpacked from Google's `.deb` (`ar x`, then `tar -xf data.tar.xz`) in `opt/chrome156`, holyWisp built from a clone in
`src/holyWisp`, and `xvfb` from apt:

```sh
cd /root/bench-proxies/stomp && export PATH=/root/bench-proxies/opt/node24/bin:$PATH
npm ci && npm run build
python3 -I bench/run.py --out /root/bench-proxies/results/full --contenders /root/bench-proxies/contenders \
  --chrome /root/bench-proxies/opt/chrome156/root/opt/google/chrome/chrome \
  --holywisp /root/bench-proxies/src/holyWisp/build/release/holywisp
```

On the desktop the defaults fit (`npm run bench`), but a machine that runs other work is no place for timings.

Use `--only stomp-js,scramjet` to run some rows (native always runs), `--scenarios
size,fidelity,fixtures,first-visit,spa,memory,real,rewrite-offline,sites` to pick scenarios, `--sites wikipedia,mdn`
to pick corpus sites, and `--merge` to keep the scenarios already in an `--out` directory and replace only the ones run
again. `--repeats` (default 5) applies to every timing, `--parallel` (default 8) is how many corpus sites load at once,
`--spacing` (default 15000 ms) the pause between two loads of the same site. The exact holyWisp command line, every
version and commit, the load average before and after every scenario and every 30 s are stored in `results.json` under
`meta`.

Within a scenario the rows run one after another, and the order rotates by one each repeat (reversing after every full
rotation), the rule holyWisp's harness uses. The first row of a scenario inherits whatever the previous one left
behind (a warm disk cache, a busy relay), so a fixed order would favour or penalise whoever always runs first. With
eight rows, five repeats give every row a different position each time; use 16 to give every row every position twice.
Each load gets a fresh browser context unless the scenario is about reuse, so no row inherits another's cookies,
caches or service workers.

## Method

### One network for everyone

holyWisp runs once per run with its stock settings plus: flood protection off (its per-destination limit closes the
101st stream a second to one origin, which a page bursting to its own host reaches; the production edges run with it
off too), loopback, private and literal-IP destinations allowed (the fixture servers), IPv4 first, `TCP_NODELAY`, and a
`dns-server` pointing at the harness DNS (`lib/dns.mjs`). That DNS answers names under `.bench.test` with 127.0.0.1 and
forwards every other question to the system resolver, so the fixture servers have real origins
(`http://a.bench.test:<port>`, `b.`, `c.`) while real sites resolve as usual. The two contenders that fetch from Node
run with `lib/node-dns-shim.cjs` preloaded, which maps the same names.

Chrome for the proxied rows runs with
`--host-resolver-rules=MAP *.bench.test 127.0.0.1:<leak catcher>, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1`:
a request a proxied page makes without going through its proxy either fails (real sites, counted as a leak in site
support) or lands on the leak catcher (fixtures, counted per vector). Chrome for the native row maps only
`*.bench.test`, to the fixtures. Headless Chrome is given a regular Chrome user agent; headful keeps its own.

### Measuring inside the page

Every document every row loads gets `lib/probe.js` in an isolated world (`Page.addScriptToEvaluateOnNewDocument` with
a world name). An isolated world shares the DOM but none of the page's JavaScript objects, so what a proxy hooks in the
page's world does not change what the harness reads: the real `location`, `innerText`, element counts, paint entries
(first and largest contentful paint), the end of the load, and the attribute fixture pages write their results into.
Uncaught exceptions and unhandled rejections come from Chrome itself (`Runtime.exceptionThrown`, by frame), which
also sees a document a page or proxy rewrote with `document.open()`, where every listener on the window is dropped.
Native loads are top-level tabs; proxied loads are the contender's frame covering the same 1280x800
viewport, so screenshots compare pixel for pixel.

"Load time" is wall time from the harness asking for the navigation (`page.goto` natively, the host page's `go(url)`
through a proxy) to the load event of the document that ends up in the frame, on the wall clock Chrome and the harness share (a page
that moves on to another document after its first one loaded is followed to the last one; a document written with
`document.open()` ends when its `readyState` becomes complete). A proxy's
start-up (registering its service worker, loading its bundles and transport) is not in it; the first-visit scenario
measures that.

### Site support

Each corpus site is loaded natively, then through every proxied row (order rotated per site), then natively again, with
15 s between two loads of one site and eight sites in flight at once. After the load event the harness waits 3 s, takes
a screenshot, reads the text and counters, then scrolls with the mouse wheel and either types a query into the site's
search box and presses Enter (sites with an obvious one) or clicks the first visible link, and checks that a new page
loads. Per row and site:

- **content** is the mean of the screenshot SSIM (320x200 grey, 8x8 windows) and the share of the native page's words
  the proxied page also shows, each against whichever native load it resembles more, divided by how similar the two
  native loads were to each other (capped at 1), so a page that changes from load to load is not held against a proxy;
- **interaction** is the share of the interactions that worked natively that also worked through the proxy;
- **score** is 0.75 content + 0.25 interaction for a page that loaded, else 0: **pass** at 0.85 or more, **partial** at
  0.5 or more, **fail** below; **challenge** when the proxied load got a challenge, block or rate-limit page the native
  load did not; **boot fail** when the proxy never became ready. Sites that do not load natively, or show the native
  browser a challenge, are reported but not scored.

The corpus (`lib/sites.mjs`) covers search, news, video, social pages readable without an account, documentation,
shopping, maps, games, single-page apps, sites behind Cloudflare and other bot walls, and pages built on WebSocket,
WebRTC, workers, WASM or service workers. No load signs in and no challenge is ever answered: a challenge is a result.
Each site gets two native loads and one per proxied row, each followed by one interaction. One load per row and site is
noisy (a banner shown one time in three, a rate limit); compare the aggregates, not single cells.

### Speed

- **Fixture pages** (`fixtures/speed/`): an article (text, 11 images, 3 scripts), a page with 200 subresources, and the
  script-corpus page. Assets are cacheable for a day and pages revalidate, as an ordinary site sends them. Per load:
  load time, FCP and LCP, Chrome CPU time (every Chrome process, `SystemInfo.getProcessInfo`), server CPU time (holyWisp
  or the contender's own server, `/proc`), and bytes, counted the same way for every row: what the fixture server sent (a proxy that caches or
  blocks asks for less). For the real sites, bytes are the IP bytes the host exchanged with the network in both directions
  during the load (the kernel's IPv4 and IPv6 octet counters minus loopback; nothing else uses the network while the
  timing scenarios run).
- **First visit**: a fresh context, the host page until the proxy is ready, the article, then the article again in the
  same tab.
- **Single-page app**: 20 client-side navigations (`pushState`, a JSON fetch, render), from the click to the frame
  after the new view is in the DOM.
- **Memory**: a fresh Chrome per measurement, one tab on a blank page, then a page with 20 ad-like cross-origin frames;
  proportional set size of every Chrome process, and the JS heap of the tab's process. Natively the cross-site frames
  live in processes of their own; through any proxy they share the proxy's origin and process, which is why the PSS of
  all processes is the comparison to read. The frames do what an ad tag or a social embed does (an image, a canvas, a
  timer, an observer) but are named so that no filter list matches them: a content blocker that refused them would
  make its row's frames look free. A measurement counts only if the fixture server served all 20 frames.
- **Real sites**: six large sites (`TIMED_SITES` in `lib/sites.mjs`), each loaded five times per row.
- **Rewrite throughput**: in the browser, megabytes of the script corpus per second through the proxy, download and
  execution included; offline, each rewriter alone in Node on the corpus, called as the proxy calls it for a script
  response (`lib/rewrite-offline.mjs` names the entry point and options per contender). The offline table uses the
  scripts every rewriter handled; `offline_all` in `results.json` has each rewriter's own set.

### Fidelity and leaks

`lib/fidelity.mjs` loads each page of `fixtures/fidelity/` natively and through every row; the page runs its checks and
writes what it observed, and a check passes for a row when its value equals native Chrome's. A check with no native
value is dropped with a note; a page that never finishes through a proxy fails all of its checks. The leak pages fire
each escape vector at its own URL on another fixture origin: the vector leaked when the leak catcher saw it, was
proxied when the fixture server saw it through the proxy, and counts only if it fired natively.

### Size

`lib/size.mjs` measures the files a row's browser downloads for the proxy's own machinery (service worker, client
bundles, rewriter, transport and their wasm), raw and brotli at quality 11, from the list each adapter's `assets()`
returns. `configs/<id>.json` records, per contender, which files are always fetched and which are conditional (a
worker bundle, an HTTP/3 module that an origin triggers). Two of STomp's choices matter for comparing the row fairly:
the content blocker's `blocker.wasm` is counted only on the blocker-on rows, and the WebRTC stand-in stack (`rtc.wasm`,
`rtcStack.js`, `rtcWorker.js`) is left out, because it loads only when a page constructs an `RTCPeerConnection`, which
neither the size scenario nor ordinary browsing does; `RESULTS.md` reports its bytes separately. The narrative in
`RESULTS.md` is written by hand from each run's figures, the way holyWisp's is.

## Reading the results

Timing cells are the median of the repeats; the whiskers in the charts and the brackets in the tables show the range.
The best proxy of each line is in bold; native Chrome is the reference, never the winner. A `DNF` means every repeat of
that row failed (the reason is in `runs.jsonl` and `logs/`); a cell with "n DNF" had n failed repeats.
