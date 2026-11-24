# Benchmark results

Run on 2026-11-24 (UTC), from powerMouse `97879b009`. Charts for every table below are in `charts/`, light and
dark; the root README embeds four of them. The method, the exact setup of every contender and how to rerun it are in
[README.md](README.md). Regenerate with `python3 -I bench/run.py` and `python3 -I bench/charts.py bench/results/<run>
--png`.

The host was `devbox`: an AMD Ryzen 9 7950X (the harness recorded nproc 28 and 48 GB), Debian 13, kernel
7.0.14-30-pve. It was not idle. The load average at the start was 1.87, 6.23, 8.16, and the driver was started at
nice 15. Absolute milliseconds are this machine's. Do not compare them with the 2026-11-12 tables, which came from an
idle 16-vCPU Xeon guest. Rows inside one scenario are still comparable: they ran one after another, the order rotated
by one each repeat and reversed after each full rotation, and five repeats give each of the eight rows a different
position every time.

Read differences of a few percent as noise. One load of a real site through a proxy spans a wide range (a banner shown
one visit in three, an upstream that answers slower once), which is why the tables show the range in brackets and the
charts draw it as a whisker. Compare rows within a line, and prefer the aggregates (the geometric mean of the six
timed sites, the site-support score) to any single cell. Native Chrome, with no proxy, is the reference in every line
and is never the winner. The best proxy in a line is in bold.

The tree under test is `97879b009`. Master later pinned the demo's estrogen to 0.5.7 (`ec84045d3`); that pin does not
change the proxy these numbers measure. There is one STomp row. The rewriter is the wasm one. `STomp (no adblock)` is
that same build with the content blocker off.

|                                          | native Chrome | STomp  | STomp (no adblock) | Scramjet | Ultraviolet | stompV1 | powerMouseV1 | Ramjet |
| ---------------------------------------- | ------------- | ------ | ------------------ | -------- | ----------- | ------- | ------------ | ------ |
| site support score (0-100)               | 99            | 94     | **96**             | 90       | 76          | 51      | 47           | 88     |
| sites passed                             | 75            | 67     | **70**             | 65       | 48          | 27      | 17           | 62     |
| fidelity checks equal to native (of 169) | 169           | **159** | **159**           | 120      | 90          | 63      | 36           | 100    |
| escape vectors leaked (of 80)            | 0             | **0**  | **0**              | 2        | 10          | 12      | 37           | 5      |
| real-site load, x native (geomean of 6)  | 1.00x         | 2.72x  | 2.17x              | 3.24x    | 2.96x       | 1.82x   | **1.43x**    | 2.94x  |
| article fixture load (ms)                | 19            | 177    | 107                | 263      | 125         | 68      | **28**       | 163    |
| first visit, proxy start + load (ms)     | 21            | 303    | 227                | 329      | 217         | 135     | **49**       | 205    |
| single-page-app navigation (ms)          | 8.5           | 4.0    | 3.9                | 3.9      | **2.7**     | 3.2     | DNF          | 3.8    |
| script corpus through the proxy (MB/s)   | 59.6          | 22.1   | 22.2               | 19.3     | 8.3         | 9.6     | **34.6**     | 19.3   |
| rewriter alone (MB/s)                    | n/a           | 61.9   | n/a                | 76.4     | 14.0        | 8.6     | **349**      | 74.1   |
| memory, one blank tab (MB PSS)           | 180           | 321    | 279                | 231      | 247         | 214     | DNF          | **211** |
| memory per ad-like frame (KB)            | 2,844         | 5,664  | 5,282              | 15,407   | 4,794       | 6,204   | DNF          | **4,791** |
| proxy download, brotli (KB)              | n/a           | 6,610  | 2,712              | 861      | 702         | 385     | **1**        | 840    |

Proxy site-support scores leave out the 10 sites native Chrome itself did not load cleanly (9 challenges and 1
failure), so a proxy is scored on 75 sites. Native's 75 passes are out of all 85.

## Versions

| row                | version                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| STomp              | Fracital/powerMouse 97879b009; @sysce/stomp 4.2.0; @mercuryworkshop/epoxy-transport 3.0.2-fracital.1 (75741326)                                                              |
| STomp (no adblock) | the same build, content blocker off                                                                                                                                         |
| Scramjet           | MercuryWorkshop/scramjet bb5a8550; @mercuryworkshop/scramjet 3.0.0-alpha; scramjet-controller 0.0.15; epoxy-transport 3.0.2; epoxy-tls 2.1.20-1                            |
| Ultraviolet        | @titaniumnetwork-dev/ultraviolet 3.2.10; @mercuryworkshop/bare-mux 2.1.8; epoxy-transport 2.1.28; epoxy-tls 2.1.18-1                                                         |
| stompV1            | Fracital/stompV1 7ee94c22; its own Bare server in Node, not holyWisp                                                                                                        |
| powerMouseV1       | Fracital/powerMouseV1 8fdaf44d; Node fetches the page and returns it regex-rewritten, not holyWisp                                                                          |
| Ramjet             | gitlab.com/hackz00/ramjet 452ca00c; @ramjet/core 2.0.67-ramjet.2; epoxy-transport 3.0.2; epoxy-tls 2.1.20-1                                                                 |
| Chrome             | Chromium 159.0.8154.6, Playwright's chromium-1255 build, not Google's branded Chrome                                                                                        |
| Node               | v24.22.3 (every Node-side contender and the harness)                                                                                                                        |
| holyWisp           | holywisp 0.5.3                                                                                                                                                              |

```
CPU: AMD Ryzen 9 7950X (nproc 28), 48 GB
Chromium 159.0.8154.6, Node v24.22.3
Timings: 5 repeats (median), rows interleaved and rotated
Load average at start: 1.87, 6.23, 8.16
```

## Where STomp wins and loses

STomp wins the three measures that decide whether a proxy shows the real web and keeps it contained. On speed it is
in the middle of this field, not at the bottom: slower than the two server-side rewriters, faster than Scramjet,
Ultraviolet and Ramjet on the six timed sites. The download is the clearest loss. The tables below have every figure.

**STomp wins:**

- **Fidelity.** 159 of 169 web-platform checks match native Chrome, against 120 for Scramjet, 100 for Ramjet, 90 for
  Ultraviolet, 63 for stompV1 and 36 for powerMouseV1. STomp is ahead by 39 checks over the next proxy. It leads or
  ties every area except history, where it matches 6 of 11 and Scramjet matches 9 (Ramjet 8). The misses beside that
  are url resolution 16 of 17, secure context 6 of 8 and iframes 9 of 11. Location, cookies, storage, postMessage,
  workers, fetch and XHR, sockets and the rest match native in full. The blocker does not change the fidelity score.
- **Containment.** 0 of 80 escape vectors reached the network outside the proxy. Scramjet leaks 2, Ramjet 5,
  Ultraviolet 10, stompV1 12 and powerMouseV1 37.
- **Site support.** With the blocker on, STomp scores 94 and passes 67 of the 75 sites native loaded cleanly, with no
  hard fail and no boot fail. With the blocker off it scores 96 and passes 70, the best of any proxy. Scramjet is 90
  and 65, Ramjet 88 and 62, Ultraviolet 76 and 48. Video, social, shopping, maps and apps score 100. The weak category
  is news, at 60 with the blocker and 67 without (Scramjet 67). Docs is 94 against Scramjet's 100.

**STomp loses, biggest gap first:**

- **Bundle size.** STomp ships 6,610 KB brotli with the blocker and 2,712 KB without, against 861 KB for Scramjet, 840
  KB for Ramjet, 702 KB for Ultraviolet and 385 KB for stompV1. powerMouseV1 is 1 KB because the rewriting happens on
  its server. Of STomp's 6,610 KB, the adblock snapshot is 3,526 KB (the file is already gzip, so brotli barely
  shrinks it), `blocker.wasm` is 292 KB and the resource list is 79 KB. The transport is 1,704 KB: 822 KB of epoxy
  wasm and 824 KB of the HTTP/3 wasm, plus the small JavaScript beside them. STomp's own code, the service worker, the
  injects and the rewriter, is 1,007 KB.
- **Real-site load.** The geometric mean over the six timed sites is 2.72x native with the blocker and 2.17x without,
  against 1.43x for powerMouseV1 and 1.82x for stompV1. That is still faster than Scramjet (3.24x), Ultraviolet
  (2.96x) and Ramjet (2.94x). Across the scored sites the median load is 1.75x native with the blocker and 1.59x
  without.
- **Rewriter alone.** On the shared script corpus the wasm rewriter runs at 61.9 MB/s, against 76.4 for Scramjet, 74.1
  for Ramjet and 349 for powerMouseV1's regex. Through the proxy in the browser STomp is at 22.1 MB/s, ahead of
  Scramjet and Ramjet (19.3) and behind powerMouseV1 (34.6).
- **First visit, fixtures and memory.** A cold first visit is 303 ms with the blocker and 227 ms without, against
  powerMouseV1's 49 ms. The article fixture is 177 ms and 107 ms, against 28 ms. A blank tab holds 321 MB (279 MB
  without the blocker) against Ramjet's 211 MB, the lightest proxy that finished. An ad-like frame costs 5,664 KB
  against Ramjet's 4,791 KB. Scramjet's frame is 15,407 KB, so STomp is not the heaviest there. powerMouseV1 did not
  finish the memory scenario or the single-page navigation.
- **Smaller gaps.** Single-page navigation is 4.0 ms, faster than native's 8.5 ms and behind Ultraviolet's 2.7 ms.
  History is the fidelity area STomp does not lead, as above. News is the site-support category it does not lead.

Three things frame the size and speed numbers:

- **The content blocker dominates the download and is on by default.** STomp is the only proxy here with one. The
  no-adblock column is the closer speed comparison against the proxies that ship no blocker. It is not a like-for-like
  size comparison: the snapshot is the reason the default row is 6.6 MB.
- **The WebRTC stack is not in the size total.** `rtc.wasm`, `rtcStack.js` and `rtcWorker.js` are 590 KB brotli
  together. They load only when a page constructs an `RTCPeerConnection`, which the size scenario and ordinary
  browsing do not do, so a page that makes a call pays them on top.
- **This host was shared.** A few percent, and some of the wider real-site ranges, can be the machine rather than the
  proxy. The rotation keeps that from landing on one row. An idle machine would be the place for a run whose absolute
  times need to be compared with another date.

The tables below are the harness output for this run (`bench/results/full/results.md`).


### Site support

| | score | pass | partial | challenge | fail | boot fail | sites scored | extra JS errors (median) | load time vs native (median) |
|---|---|---|---|---|---|---|---|---|---|
| native Chrome | 99 | 75 | 0 | 9 | 1 | 0 | 85 | 0 | 1.00x |
| STomp | 94 | 67 | 6 | 2 | 0 | 0 | 75 | 0 | 1.75x |
| STomp (no adblock) | 96 | 70 | 3 | 2 | 0 | 0 | 75 | 0 | 1.59x |
| Scramjet | 90 | 65 | 4 | 5 | 1 | 0 | 75 | 0 | 2.32x |
| Ultraviolet | 76 | 48 | 11 | 4 | 12 | 0 | 75 | 0 | 1.92x |
| stompV1 | 51 | 27 | 8 | 8 | 32 | 0 | 75 | 1 | 1.48x |
| powerMouseV1 | 47 | 17 | 17 | 3 | 38 | 0 | 75 | 0 | 1.27x |
| Ramjet | 88 | 62 | 6 | 5 | 2 | 0 | 75 | 0 | 1.97x |

### Site support by category (score 0-100)

| | search | news | video | social | docs | shopping | maps | games | apps | cloudflare | platform | misc |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| native Chrome | 100 | 88 | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 |
| STomp | 93 | 60 | 100 | 100 | 94 | 100 | 100 | 96 | 100 | 99 | 95 | 97 |
| STomp (no adblock) | 93 | 67 | 100 | 100 | 98 | 100 | 100 | 100 | 100 | 99 | 97 | 97 |
| Scramjet | 93 | 67 | 82 | 87 | 100 | 74 | 83 | 100 | 97 | 66 | 95 | 100 |
| Ultraviolet | 72 | 62 | 59 | 74 | 97 | 49 | 77 | 87 | 97 | 59 | 79 | 60 |
| stompV1 | 73 | 19 | 18 | 58 | 82 | 47 | 30 | 33 | 57 | 31 | 65 | 54 |
| powerMouseV1 | 49 | 28 | 27 | 50 | 72 | 29 | 55 | 37 | 56 | 45 | 52 | 51 |
| Ramjet | 93 | 65 | 80 | 87 | 98 | 75 | 81 | 100 | 97 | 66 | 92 | 94 |

### Fixture page loads, go() to the load event (ms, median of repeats, range in brackets; lower is better)

| | native Chrome | STomp | STomp (no adblock) | Scramjet | Ultraviolet | stompV1 | powerMouseV1 | Ramjet |
|---|---|---|---|---|---|---|---|---|
| article | 19 (19-153) | 177 (172-182) | 107 (99-121) | 263 (261-280) | 125 (121-130) | 68 (62-70) | **28** (26-33) | 163 (156-186) |
| 200 subresources | 57 (54-73) | 322 (318-351) | 241 (237-280) | 405 (393-418) | 201 (185-201) | 166 (159-191) | **146** (127-179) | 269 (264-278) |
| script corpus | 250 (238-286) | 674 (655-695) | 672 (656-692) | 774 (765-827) | 1,608 (1,591-1,661) | 1,546 (1,511-1,668) | **431** (401-435) | 771 (749-789) |

### Paint on the fixture pages (ms, median of repeats, range in brackets; lower is better)

| | native Chrome | STomp | STomp (no adblock) | Scramjet | Ultraviolet | stompV1 | powerMouseV1 | Ramjet |
|---|---|---|---|---|---|---|---|---|
| article, FCP | 24 | 188 (184-192) | 120 (112-136) | 224 (220-244) | 121 (120-127) | 76 (76-80) | **36** (36-40) | 140 (116-152) |
| article, LCP | 32 (32-44) | 188 (184-192) | 120 (112-136) | 244 (244-260) | 121 (120-127) | 76 (76-80) | **36** (36-40) | 140 (136-152) |
| 200 subresources, FCP | 44 (28-48) | 160 (156-180) | **84** (84-92) | 272 (268-280) | 145 (136-166) | 96 (96-108) | 88 (80-108) | 232 (220-240) |
| 200 subresources, LCP | 44 (28-48) | 160 (156-180) | **84** (84-92) | 272 (268-280) | 145 (136-166) | 96 (96-108) | 88 (80-108) | 232 (220-240) |

### First visit against warm (ms, median of repeats, range in brackets; lower is better)

| | native Chrome | STomp | STomp (no adblock) | Scramjet | Ultraviolet | stompV1 | powerMouseV1 | Ramjet |
|---|---|---|---|---|---|---|---|---|
| first visit (start + load) | 21 (20-24) | 303 (298-310) | 227 (213-229) | 329 (315-331) | 217 (201-221) | 135 (131-161) | **49** (45-54) | 205 (203-210) |
| proxy start alone | 0 | 122 (120-126) | 119 (115-123) | 59 (57-63) | 84 (78-92) | 71 (69-80) | **22** (22-28) | 45 (41-46) |
| second load, same tab | 9 (9-11) | 36 (35-43) | 33 (33-41) | 97 (94-99) | 26 (23-29) | 38 (37-39) | **15** (14-15) | 20 (20-27) |

### Single-page app navigation (ms, median of repeats, range in brackets; lower is better)

| | native Chrome | STomp | STomp (no adblock) | Scramjet | Ultraviolet | stompV1 | powerMouseV1 | Ramjet |
|---|---|---|---|---|---|---|---|---|
| per navigation | 8.5 (7.5-9.8) | 4.0 (3.7-4.3) | 3.9 (3.8-4.5) | 3.9 (3.8-4.6) | **2.7** (2.6-3.1) | 3.2 (2.8-3.3) | DNF | 3.8 (3.6-4.1) |

### Real sites, go() to the load event (ms, median of repeats, range in brackets; lower is better)

| | native Chrome | STomp | STomp (no adblock) | Scramjet | Ultraviolet | stompV1 | powerMouseV1 | Ramjet |
|---|---|---|---|---|---|---|---|---|
| bbc | 383 (377-444) | 920 (718-1,024) | 723 (610-878) | 852 (842-1,332) | 1,442 (1,329-1,523) | 665 (661-1,692) | **376** (370-666) | 1,526 (1,239-1,841) |
| hackernews | 453 (443-526) | 616 (603-642) | 561 (540-578) | 632 (627-658) | 594 (561-820) | 510 (496-544) | **460** (457-483) | 601 (572-935) |
| wikipedia | 90 (89-101) | 510 (385-543) | 404 (298-413) | 559 (552-581) | 450 (397-477) | 388 (381-394) | **173** (157-231) | 445 (440-456) |
| mdn | 74 (71-82) | 325 (315-338) | 245 (238-248) | 429 (414-434) | 238 (226-247) | 114 (106-142) | **93** (90-125) | 306 (299-308) |
| python-docs | 49 (41-53) | 217 (212-234) | 144 (143-168) | 289 (276-298) | 154 (142-160) | **91** (88-217) | 109 (102-184) | 169 (164-418) |
| github | 624 (249-874) | 704 (684-1,208) | **638** (619-1,488) | 1,102 (1,096-1,630) | 1,687 (1,603-1,770) | 937 (497-1,312) | 977 (944-1,162) | 1,084 (894-1,569) |

### Real sites, largest contentful paint (ms, median of repeats, range in brackets; lower is better)

| | native Chrome | STomp | STomp (no adblock) | Scramjet | Ultraviolet | stompV1 | powerMouseV1 | Ramjet |
|---|---|---|---|---|---|---|---|---|
| bbc | 208 (204-228) | 572 (524-676) | 456 (440-516) | 376 (372-532) | 935 (868-948) | 176 (160-628) | **120** (112-188) | 1,240 (1,224-1,300) |
| hackernews | 328 (316-412) | 400 (384-416) | 328 (320-360) | 472 (460-496) | 438 (414-446) | 340 (332-352) | **324** (312-344) | 448 (432-776) |
| wikipedia | 72 (72-80) | 348 (340-364) | 280 (264-300) | 396 (384-408) | 288 (235-320) | 196 (188-200) | **164** (156-228) | 308 (300-324) |
| mdn | 108 (60-116) | 248 (232-272) | 176 (172-184) | 404 (396-432) | 254 (242-261) | 132 (120-160) | **120** (112-148) | 268 (256-272) |
| python-docs | 56 (40-60) | 220 (216-236) | 152 (152-160) | 288 (268-292) | 158 (138-165) | **92** (84-212) | 100 (92-180) | 164 (160-172) |
| github | 872 (428-1,112) | 1,096 (892-1,464) | 1,040 (820-1,768) | 1,380 (1,348-2,040) | 1,676 (1,446-1,768) | **948** (520-1,320) | 984 (944-1,168) | 1,260 (1,104-1,836) |

### Rewrite throughput (MB/s, median of repeats, range in brackets; higher is better)

| | native Chrome | STomp | STomp (no adblock) | Scramjet | Ultraviolet | stompV1 | powerMouseV1 | Ramjet |
|---|---|---|---|---|---|---|---|---|
| in the browser, through the proxy | 59.63 (52.20-62.63) | 22.14 (21.46-22.79) | 22.22 (21.56-22.73) | 19.27 (18.04-19.51) | 8.27 (8.01-8.36) | 9.65 (8.94-9.88) | **34.59** (34.27-37.24) | 19.35 (18.91-19.91) |
| rewriter alone, shared scripts |  | 61.87 (59.83-63.94) |  | 76.37 (66.37-76.90) | 14.03 (12.92-14.41) | 8.61 (8.26-8.76) | **349** (319-367) | 74.10 (67.97-74.44) |
| rewriter alone, own scripts |  | 63.80 (61.43-64.92) |  | 80.06 (70.46-80.75) | 14.76 (13.92-15.10) | 8.61 (8.26-8.76) | **312** (289-318) | 78.68 (73.61-79.04) |

### Memory (MB, median of repeats, range in brackets; lower is better)

| | native Chrome | STomp | STomp (no adblock) | Scramjet | Ultraviolet | stompV1 | powerMouseV1 | Ramjet |
|---|---|---|---|---|---|---|---|---|
| all processes, blank tab (MB) | 180 (178-180) | 321 (310-322) | 279 (278-280) | 231 (229-231) | 247 (246-247) | 214 (214-215) | DNF | **211** (210-212) |
| all processes, 20 frames (MB) | 235 (233-237) | 432 (421-433) | 383 (381-383) | 532 (525-543) | 340 (340-341) | 335 (335-337) | DNF | **305** (301-308) |
| per ad-like frame (KB) | 2,844 (2,792-2,920) | 5,664 (5,651-5,744) | 5,282 (5,255-5,331) | 15,407 (15,133-16,076) | 4,794 (4,757-4,835) | 6,204 (6,164-6,331) | DNF | **4,791** (4,641-4,990) |
| JS heap, blank tab (MB) | 1 (1-1) | 5 (5-5) | 5 (5-5) | 13 (13-13) | **3** (3-3) | 4 (4-4) | DNF | 4 (4-4) |
| JS heap, 20 frames (MB) | 11 (11-11) | 32 (32-32) | 31 (31-31) | 169 (169-169) | **21** (21-21) | 58 (58-58) | DNF | 23 (23-23) |

### CPU time per load (ms, median of repeats, range in brackets; lower is better)

| | native Chrome | STomp | STomp (no adblock) | Scramjet | Ultraviolet | stompV1 | powerMouseV1 | Ramjet |
|---|---|---|---|---|---|---|---|---|
| article, Chrome | 210 (180-240) | 440 (410-460) | 310 (280-380) | 480 (460-490) | 290 (270-310) | 220 (210-240) | **100** (90-140) | 320 (290-380) |
| article, server | 0 | **0** (0-10) | **0** (0-10) | **0** (0-10) | **0** | 20 (20-30) | 40 (20-50) | **0** (0-10) |
| 200 subresources, Chrome | 300 (280-310) | 1,110 (1,100-1,170) | 970 (950-1,070) | 1,100 (1,060-1,140) | 720 (660-740) | 720 (720-780) | **320** (290-330) | 760 (750-780) |
| 200 subresources, server | 0 | 10 (0-10) | **0** (0-10) | 10 (0-10) | 10 (0-20) | 80 (60-120) | 180 (160-280) | 10 (0-20) |
| script corpus, Chrome | 400 (360-490) | 1,280 (1,260-1,350) | 1,160 (1,110-1,200) | 1,520 (1,480-1,590) | 4,310 (4,170-4,370) | 3,320 (3,190-3,390) | **370** (340-400) | 1,370 (1,330-1,460) |
| script corpus, server | 0 | **0** (0-10) | 10 (0-10) | **0** (0-10) | 10 (0-10) | 40 (30-70) | 300 (220-350) | **0** (0-10) |

### Bytes per load (KB, median of repeats, range in brackets; lower is better)

| | native Chrome | STomp | STomp (no adblock) | Scramjet | Ultraviolet | stompV1 | powerMouseV1 | Ramjet |
|---|---|---|---|---|---|---|---|---|
| article | 4,294 | **4,294** | **4,294** | **4,294** | **4,294** | **4,294** | **4,294** | **4,294** |
| 200 subresources | 1,386 | **1,386** | **1,386** | **1,386** | **1,386** | **1,386** | **1,386** | **1,386** |
| script corpus | 14,574 | **14,574** | **14,574** | **14,574** | 14,574 | **14,574** | **14,574** | **14,574** |

### Bytes per real-site load (KB, median of repeats, range in brackets; lower is better)

| | native Chrome | STomp | STomp (no adblock) | Scramjet | Ultraviolet | stompV1 | powerMouseV1 | Ramjet |
|---|---|---|---|---|---|---|---|---|
| bbc | 6,801 (3,175-9,017) | 6,195 (2,834-10,241) | 5,842 (2,271-8,710) | 6,197 (2,208-11,839) | 7,405 (2,331-15,257) | 6,026 (3,556-20,978) | **4,666** (1,827-11,143) | 7,792 (4,705-21,544) |
| hackernews | 3,878 (1,012-10,626) | 4,764 (1,005-11,964) | 3,910 (1,174-15,311) | 4,773 (82-24,616) | 3,973 (100-22,708) | 3,865 (243-16,732) | **3,774** (69-24,569) | 5,338 (820-23,620) |
| wikipedia | 3,342 (1,351-22,155) | 4,344 (1,778-4,722) | 4,240 (1,843-5,201) | 4,125 (2,501-5,313) | 4,124 (585-4,655) | 3,313 (1,360-4,885) | **2,204** (310-3,750) | 2,995 (961-4,696) |
| mdn | 4,030 (661-15,199) | 5,305 (1,703-26,452) | 4,122 (1,859-23,986) | 4,203 (716-25,992) | 4,621 (2,342-24,284) | **2,973** (1,164-24,637) | 4,342 (666-23,575) | 3,361 (624-24,084) |
| python-docs | 1,904 (90-22,281) | **748** (90-25,581) | 3,590 (101-23,855) | 3,362 (1,203-24,537) | 5,033 (97-22,715) | 5,266 (93-10,467) | 2,090 (410-7,548) | 1,000 (138-3,490) |
| github | 3,548 (2,306-6,836) | **3,086** (2,234-6,902) | 3,518 (2,263-7,348) | 5,211 (3,590-9,682) | 5,075 (2,753-8,563) | 3,702 (2,072-6,611) | 3,879 (2,106-6,892) | 4,492 (2,511-8,424) |

### Fidelity (checks equal to native)

| | total | location | url-resolution | cookies | secure-context | storage | postmessage | workers | fetch-xhr | iframes | history | sockets | misc |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| native Chrome | 169/169 | 24/24 | 17/17 | 15/15 | 8/8 | 11/11 | 15/15 | 10/10 | 19/19 | 11/11 | 11/11 | 11/11 | 17/17 |
| STomp | 159/169 | 24/24 | 16/17 | 15/15 | 6/8 | 11/11 | 15/15 | 10/10 | 19/19 | 9/11 | 6/11 | 11/11 | 17/17 |
| STomp (no adblock) | 159/169 | 24/24 | 16/17 | 15/15 | 6/8 | 11/11 | 15/15 | 10/10 | 19/19 | 9/11 | 6/11 | 11/11 | 17/17 |
| Scramjet | 120/169 | 23/24 | 12/17 | 11/15 | 4/8 | 9/11 | 15/15 | 5/10 | 10/19 | 5/11 | 9/11 | 3/11 | 14/17 |
| Ultraviolet | 90/169 | 21/24 | 8/17 | 7/15 | 5/8 | 7/11 | 11/15 | 3/10 | 7/19 | 4/11 | 6/11 | 1/11 | 10/17 |
| stompV1 | 63/169 | 9/24 | 9/17 | 6/15 | 5/8 | 2/11 | 6/15 | 0/10 | 2/19 | 3/11 | 4/11 | 5/11 | 12/17 |
| powerMouseV1 | 36/169 | 5/24 | 0/17 | 3/15 | 1/8 | 3/11 | 5/15 | 3/10 | 3/19 | 0/11 | 3/11 | 2/11 | 8/17 |
| Ramjet | 100/169 | 23/24 | 11/17 | 11/15 | 5/8 | 6/11 | 11/15 | 1/10 | 9/19 | 4/11 | 8/11 | 1/11 | 10/17 |

### Leaks (escape vectors that reached the network outside the proxy)

| | vectors leaked | requests leaked |
|---|---|---|
| native Chrome | 0/80 | 0 |
| STomp | 0/80 | 0 |
| STomp (no adblock) | 0/80 | 0 |
| Scramjet | 2/80 | 2 |
| Ultraviolet | 10/80 | 10 |
| stompV1 | 12/80 | 12 |
| powerMouseV1 | 37/80 | 37 |
| Ramjet | 5/80 | 5 |

### Size of what the browser downloads for the proxy itself (KB)

| | raw | brotli |
|---|---|---|
| STomp | 12,991 | 6,610 |
| STomp (no adblock) | 7,946 | 2,712 |
| Scramjet | 2,791 | 861 |
| Ultraviolet | 2,157 | 702 |
| stompV1 | 1,658 | 385 |
| powerMouseV1 | 2 | 1 |
| Ramjet | 2,565 | 840 |

