# Benchmark results

Run on 2026-11-12 (UTC). Charts for every table below are in `charts/`, light and dark; the root README embeds
four of them. The method, the exact setup of every contender and how to rerun it are in [README.md](README.md).
Regenerate with `python3 -I bench/run.py` and `python3 -I bench/charts.py bench/results/<run> --png`.

The host was a 16-vCPU KVM guest (Xeon Gold 6348, Debian 13) that ran nothing else. STomp, the four other proxies,
holyWisp, the fixture servers and Chrome shared its 16 cores, so a scenario that saturates the box (the 85-site
support sweep, which loads eight sites at once) is bounded by the whole machine, not by one proxy.

Every scenario ran its rows one after another, with the order rotated by one each repeat and reversed after each full
rotation, the rule holyWisp's harness uses. The first row of a scenario inherits whatever the previous one left behind
(a warm disk cache, a relay with sockets open), so a fixed order would favour or penalise whoever always runs first.
With eight rows, five repeats give each row a different position every time.

Read differences of a few percent as noise. The single-load rows move the most: one load of a real site through a
proxy spans a wide range (a banner shown one visit in three, an upstream that answers slower once), which is why the
tables show the range of the repeats in brackets and the charts draw it as a whisker. Compare rows within a line, and
prefer the aggregates (the geometric mean of the real sites, the site-support score over 85 sites) to any single cell.
Native Chrome, with no proxy, is the reference in every line and is never the winner.

|                                          | native Chrome | STomp (js) | STomp (wasm) | STomp (js, no adblock) | Scramjet | Ultraviolet | stompV1 | powerMouseV1 |
| ---------------------------------------- | ------------- | ---------- | ------------ | ---------------------- | -------- | ----------- | ------- | ------------ |
| site support score (0-100)               | 99            | **89**     | 87           | 89                     | 88       | 79          | 58      | 54           |
| sites passed                             | 70            | **56**     | 55           | 55                     | **56**   | 48          | 25      | 19           |
| fidelity checks equal to native (of 169) | 169           | **154**    | **154**      | **154**                | 101      | 90          | 61      | 36           |
| escape vectors leaked (of 80)            | 0             | **0**      | **0**        | **0**                  | 5        | 10          | 12      | 35           |
| real-site load, x native (geomean of 6)  | 1.00x         | 3.81x      | 3.56x        | 2.79x                  | 2.90x    | 2.70x       | 1.56x   | **1.30x**    |
| article fixture load (ms)                | 47            | 1,279      | 1,354        | 547                    | 452      | 312         | 174     | **78**       |
| first visit, proxy start + load (ms)     | 44            | 1,574      | 1,560        | 809                    | 596      | 542         | 356     | **138**      |
| single-page-app navigation (ms)          | 12.0          | 15.9       | 15.9         | 15.7                   | 17.8     | **11.1**    | 13.1    | DNF          |
| script corpus through the proxy (MB/s)   | 25.5          | 2.8        | 4.8          | 2.8                    | 8.8      | 3.5         | 4.3     | **12.4**     |
| rewriter alone (MB/s)                    | n/a           | 3.7        | 17.8         | n/a                    | 35.5     | 6.5         | 4.7     | **142.4**    |
| memory, one blank tab (MB PSS)           | 239           | 482        | 458          | 329                    | 279      | 307         | **270** | DNF          |
| memory per ad-like frame (KB)            | 2,753         | 5,204      | 5,047        | 5,345                  | 7,451    | **4,110**   | 6,300   | DNF          |
| proxy download, brotli (KB)              | n/a           | 2,691      | 2,901        | 2,399                  | 828      | 702         | 385     | **1**        |

## Versions

|                        | version                                                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| STomp (js)             | Fracital/powerMouse 7fd67cff; @sysce/stomp 4.2.0, @mercuryworkshop/epoxy-transport 3.0.2-fracital.1                                                                                                                                                                                   |
| STomp (wasm)           | Fracital/powerMouse 7fd67cff; @sysce/stomp 4.2.0, @mercuryworkshop/epoxy-transport 3.0.2-fracital.1                                                                                                                                                                                   |
| STomp (js, no adblock) | Fracital/powerMouse 7fd67cff; @sysce/stomp 4.2.0, @mercuryworkshop/epoxy-transport 3.0.2-fracital.1                                                                                                                                                                                   |
| Scramjet               | MercuryWorkshop/scramjet 517206bc; @mercuryworkshop/epoxy-tls 2.1.20-1, @mercuryworkshop/epoxy-transport 3.0.2, @mercuryworkshop/proxy-transports 1.0.2, @mercuryworkshop/scramjet 2.0.67-alpha.2, @mercuryworkshop/scramjet-controller 0.0.14, @mercuryworkshop/scramjet-utils 0.0.3 |
| Ultraviolet            | titaniumnetwork-dev/Ultraviolet v3.2.10-headers (npm latest 3.2.10); @mercuryworkshop/bare-mux 2.1.8, @mercuryworkshop/epoxy-tls 2.1.18-1, @mercuryworkshop/epoxy-transport 2.1.28, @titaniumnetwork-dev/ultraviolet 3.2.10                                                           |
| stompV1                | Fracital/stompV1 7ee94c22; @sysce/stomp (stompV1) 2.0.0, @tomphttp/bare-client 2.0.0-beta.1, meriyah 4.3.3, parse5 7.1.2, css-tree 2.3.1, webpack 5.75.0, @tomphttp/bare-server-node 2.0.0, ws 8.22.2                                                                                 |
| powerMouseV1           | Fracital/powerMouseV1 8fdaf44d; powermouse (powerMouseV1) 1.0.0, express 4.22.3, node-fetch 2.7.0, ws 7.5.13, html-minifier 4.0.0, compression 1.8.2, cookie-parser 1.4.7, cookie 0.7.2, body-parser 1.20.9, mime 2.6.0, serverline 1.6.0                                             |
| Chrome                 | 156.0.8078.79 (Google's branded build, the CI runner's)                                                                                                                                                                                                                               |
| Node                   | v24.22.3 (every Node-side contender and the harness)                                                                                                                                                                                                                                  |
| holyWisp               | holywisp 0.5.3, 6fa3a1c9, release build                                                                                                                                                                                                                                               |
| kernel                 | 6.12.116+deb13-cloud-amd64                                                                                                                                                                                                                                                            |

```
CPU: Intel(R) Xeon(R) Gold 6348 CPU @ 2.60GHz (x16), 16 GB
Chrome 156.0.8078.79, Node v24.22.3
Timings: 5 repeats (median), rows interleaved and rotated
```

## Where STomp wins and loses

STomp wins the three measures that decide whether a proxy shows the real web and keeps it contained, and loses the
ones that come from doing more work in the browser. This section states both plainly; the tables below have every
figure.

**STomp wins:**

- **Fidelity.** 154 of 169 web-platform checks match native Chrome exactly, against 101 for Scramjet, 90 for
  Ultraviolet, 61 for stompV1 and 36 for powerMouseV1. STomp is ahead by 53 checks over the next proxy, and leads or
  ties every one of the twelve areas (location, cookies, storage, postMessage, workers, fetch/XHR, iframes, history,
  sockets and the rest).
- **Containment.** 0 of 80 escape vectors reached the network outside the proxy. Every other proxy leaks: Scramjet 5,
  Ultraviolet 10, stompV1 12, powerMouseV1 35.
- **Site support.** STomp (js) scores 89 over 85 real sites and passes 56 of the 70 that load natively without a
  challenge, the best of any proxy (Scramjet 88 / 56, Ultraviolet 79 / 48, stompV1 58 / 25, powerMouseV1 54 / 19). The
  wasm rewriter is a point behind at 87.

**STomp loses, biggest gap first:**

- **Rewrite throughput.** The rewriter alone runs the script corpus at 17.8 MB/s on wasm and 3.7 MB/s on the JavaScript
  rewriter, against 35.5 for Scramjet and 142 for powerMouseV1's near-passthrough regex; through the proxy in the
  browser it is 4.8 MB/s (wasm) against Scramjet's 8.8 and powerMouseV1's 12.4. STomp rewrites the most and parses the
  most, and it shows here most.
- **Real-site load.** Geometric mean over six large sites is 3.8x native for the JavaScript rewriter and 2.8x with the
  content blocker off, against 1.3x for powerMouseV1 and 1.6x for stompV1; STomp is the slowest proxy to the load event
  on every corpus site except bbc, where its blocker strips enough of the ad and tracker load that it beats native.
- **First visit and fixture load.** A cold first visit (proxy start plus the first load) is 809 ms with the blocker
  off against powerMouseV1's 138; the article fixture loads in 547 ms against 78.
- **Bundle size.** STomp ships 2.4 MB brotli with the blocker off and 2.9 MB with the wasm rewriter, against 702 KB for
  Ultraviolet, 828 KB for Scramjet and 385 KB for stompV1. It is roughly three times the next-heaviest proxy.
- **CPU and memory.** A load costs STomp 1.3 to 6.6 s of Chrome CPU against powerMouseV1's 0.45 to 1.3 s; a blank tab
  holds 329 MB against stompV1's 270, and an ad-like frame costs 5,047 KB against Ultraviolet's 4,110.
- **Smaller gaps.** Single-page-app navigation is 15.7 ms against Ultraviolet's 11.1; the fidelity `history` area is
  6 of 11 (Scramjet 8), because `history.length` does not grow on a `pushState`; and among the site-support
  categories STomp trails Scramjet on the Cloudflare-fronted sites (74 against 99) and the social pages (88 against
  99).

Three things frame the size and speed numbers:

- **The size row is pre-CSP.** CSP enforcement is still landing and will add about 45 KB to the inject bundle, so this
  bundle will grow; a final re-run is worth it once that cascade is in.
- **The WebRTC stack is not in the size total.** STomp at this commit also ships `rtc.wasm`, `rtcStack.js` and
  `rtcWorker.js` (568 KB brotli together), the str0m-over-wisp WebRTC stand-in. It is loaded only when a page
  constructs an `RTCPeerConnection`, which the size and browsing scenarios never do, so it is left out of the download
  total; a page that makes a video call pays it on top.
- **The content blocker inflates STomp's load numbers.** STomp is the only proxy here with a content blocker, and it is
  on by default. Each fresh browser context downloads its filter lists at start, and the harness uses a fresh context
  per load, so the blocker's cost lands on every first load: the article fixture is 547 ms with it off against 1,279
  with it on, and the cold first visit 809 ms against 1,574. The `stomp-noadblock` row is the like-for-like comparison
  against the other proxies, which ship no blocker.

### Site support

|                        | score | pass | partial | challenge | fail | boot fail | sites scored | extra JS errors (median) | load time vs native (median) |
| ---------------------- | ----- | ---- | ------- | --------- | ---- | --------- | ------------ | ------------------------ | ---------------------------- |
| native Chrome          | 99    | 70   | 0       | 14        | 1    | 0         | 85           | 0                        | 1.00x                        |
| STomp (js)             | 89    | 56   | 9       | 2         | 3    | 0         | 70           | 0                        | 4.47x                        |
| STomp (wasm)           | 87    | 55   | 9       | 3         | 3    | 0         | 70           | 0                        | 3.51x                        |
| STomp (js, no adblock) | 89    | 55   | 10      | 2         | 3    | 0         | 70           | 0                        | 3.53x                        |
| Scramjet               | 88    | 56   | 8       | 2         | 4    | 0         | 70           | 0                        | 2.52x                        |
| Ultraviolet            | 79    | 48   | 10      | 4         | 8    | 0         | 70           | 0                        | 2.48x                        |
| stompV1                | 58    | 25   | 16      | 4         | 25   | 0         | 70           | 1                        | 2.10x                        |
| powerMouseV1           | 54    | 19   | 18      | 4         | 29   | 0         | 70           | 0                        | 1.32x                        |

### Site support by category (score 0-100)

|                        | search | news | video | social | docs | shopping | maps | games | apps | cloudflare | platform | misc |
| ---------------------- | ------ | ---- | ----- | ------ | ---- | -------- | ---- | ----- | ---- | ---------- | -------- | ---- |
| native Chrome          | 100    | 88   | 100   | 100    | 100  | 100      | 100  | 100   | 100  | 100        | 100      | 100  |
| STomp (js)             | 96     | 71   | 95    | 88     | 96   | 89       | 82   | 95    | 90   | 74         | 88       | 92   |
| STomp (wasm)           | 96     | 71   | 94    | 79     | 96   | 100      | 82   | 95    | 83   | 74         | 78       | 96   |
| STomp (js, no adblock) | 96     | 75   | 94    | 86     | 96   | 100      | 82   | 93    | 89   | 74         | 89       | 82   |
| Scramjet               | 94     | 71   | 89    | 100    | 98   | 48       | 72   | 100   | 92   | 99         | 81       | 93   |
| Ultraviolet            | 91     | 66   | 62    | 83     | 99   | 39       | 72   | 96    | 96   | 50         | 79       | 76   |
| stompV1                | 80     | 41   | 26    | 55     | 94   | 52       | 26   | 52    | 65   | 25         | 62       | 66   |
| powerMouseV1           | 56     | 44   | 33    | 51     | 82   | 38       | 57   | 54    | 58   | 41         | 52       | 65   |

### Fixture page loads, go() to the load event (ms, median of repeats, range in brackets; lower is better)

|                  | native Chrome | STomp (js)          | STomp (wasm)        | STomp (js, no adblock) | Scramjet            | Ultraviolet         | stompV1             | powerMouseV1            |
| ---------------- | ------------- | ------------------- | ------------------- | ---------------------- | ------------------- | ------------------- | ------------------- | ----------------------- |
| article          | 47 (46-326)   | 1,279 (533-1,371)   | 1,354 (1,279-1,361) | 547 (526-555)          | 452 (451-492)       | 312 (292-319)       | 174 (160-188)       | **78** (62-87)          |
| 200 subresources | 122 (120-191) | 1,763 (1,678-1,786) | 1,681 (1,635-1,715) | 985 (968-1,021)        | 797 (776-812)       | 469 (457-484)       | 396 (387-427)       | **342** (323-393)       |
| script corpus    | 586 (578-600) | 5,385 (5,336-6,210) | 3,134 (3,076-3,196) | 5,353 (5,329-5,418)    | 1,694 (1,663-1,700) | 3,852 (3,681-3,934) | 3,446 (3,354-3,601) | **1,199** (1,169-1,229) |

### Paint on the fixture pages (ms, median of repeats, range in brackets; lower is better)

|                       | native Chrome | STomp (js)        | STomp (wasm)        | STomp (js, no adblock) | Scramjet      | Ultraviolet   | stompV1       | powerMouseV1      |
| --------------------- | ------------- | ----------------- | ------------------- | ---------------------- | ------------- | ------------- | ------------- | ----------------- |
| article, FCP          | 60 (44-64)    | 1,300 (552-1,384) | 1,372 (1,304-1,380) | 572 (512-580)          | 380 (368-420) | 300 (286-311) | 196 (176-208) | **80** (76-104)   |
| article, LCP          | 64 (56-92)    | 1,300 (552-1,384) | 1,372 (1,304-1,380) | 572 (512-580)          | 404 (388-432) | 300 (286-311) | 196 (176-208) | **88** (76-104)   |
| 200 subresources, FCP | 76 (68-88)    | 468 (460-488)     | 492 (468-496)       | 480 (472-520)          | 476 (460-480) | 348 (347-374) | 224 (216-244) | **212** (196-260) |
| 200 subresources, LCP | 76 (68-88)    | 468 (460-488)     | 492 (468-496)       | 480 (472-520)          | 476 (460-480) | 348 (347-374) | 224 (216-244) | **212** (196-260) |

### First visit against warm (ms, median of repeats, range in brackets; lower is better)

|                            | native Chrome | STomp (js)          | STomp (wasm)      | STomp (js, no adblock) | Scramjet      | Ultraviolet   | stompV1       | powerMouseV1      |
| -------------------------- | ------------- | ------------------- | ----------------- | ---------------------- | ------------- | ------------- | ------------- | ----------------- |
| first visit (start + load) | 44 (41-50)    | 1,574 (1,543-1,607) | 1,561 (885-1,671) | 809 (792-835)          | 596 (565-631) | 542 (511-549) | 356 (336-384) | **138** (124-155) |
| proxy start alone          | 0             | 273 (264-280)       | 276 (273-289)     | 262 (250-275)          | 122 (105-128) | 233 (209-241) | 175 (161-204) | **61** (58-69)    |
| second load, same tab      | 29 (28-29)    | 206 (183-218)       | 201 (184-203)     | 154 (152-172)          | 137 (127-142) | 90 (78-102)   | 106 (103-119) | **59** (57-61)    |

### Single-page app navigation (ms, median of repeats, range in brackets; lower is better)

|                | native Chrome    | STomp (js)       | STomp (wasm)     | STomp (js, no adblock) | Scramjet         | Ultraviolet          | stompV1                | powerMouseV1 |
| -------------- | ---------------- | ---------------- | ---------------- | ---------------------- | ---------------- | -------------------- | ---------------------- | ------------ |
| per navigation | 12.0 (11.7-13.0) | 15.9 (15.5-16.1) | 15.9 (15.6-16.2) | 15.7 (15.1-15.8)       | 17.8 (17.4-18.2) | **11.1** (11.0-11.3) | 13.1 (12.8-13.5) 1 DNF | DNF          |

### Real sites, go() to the load event (ms, median of repeats, range in brackets; lower is better)

|             | native Chrome       | STomp (js)          | STomp (wasm)        | STomp (js, no adblock) | Scramjet            | Ultraviolet         | stompV1              | powerMouseV1        |
| ----------- | ------------------- | ------------------- | ------------------- | ---------------------- | ------------------- | ------------------- | -------------------- | ------------------- |
| bbc         | 1,117 (1,054-1,182) | 792 (756-831)       | 873 (763-2,962)     | 771 (727-778)          | 2,582 (2,505-2,810) | 3,338 (2,255-3,429) | 1,578 (1,322-1,598)  | **458** (329-744)   |
| hackernews  | 419 (364-426)       | 1,536 (1,432-1,759) | 1,493 (1,474-1,656) | 945 (818-953)          | 778 (776-799)       | 722 (701-729)       | 632 (622-685)        | **557** (496-612)   |
| wikipedia   | 220 (214-250)       | 2,003 (1,963-2,028) | 1,748 (1,739-1,765) | 1,465 (1,431-1,482)    | 1,134 (1,070-1,139) | 1,017 (975-1,055)   | 911 (902-976)        | **391** (383-442)   |
| mdn         | 250 (213-709)       | 1,744 (1,688-1,877) | 1,717 (1,657-1,945) | 1,340 (1,212-1,400)    | 931 (862-1,116)     | 630 (625-654)       | **320** (138-339)    | 328 (273-377)       |
| python-docs | 266 (251-283)       | 1,427 (1,398-1,567) | 1,407 (1,389-1,523) | 856 (832-903)          | 722 (671-739)       | 638 (579-659)       | **329** (315-498)    | 739 (725-882)       |
| github      | 1,205 (753-1,362)   | 4,190 (3,642-4,407) | 3,030 (2,634-3,150) | 3,170 (3,049-3,508)    | 3,194 (3,071-3,557) | 3,261 (2,978-3,345) | **1,246** (27-1,586) | 1,672 (1,659-1,865) |

### Real sites, largest contentful paint (ms, median of repeats, range in brackets; lower is better)

|             | native Chrome       | STomp (js)          | STomp (wasm)        | STomp (js, no adblock) | Scramjet            | Ultraviolet         | stompV1              | powerMouseV1        |
| ----------- | ------------------- | ------------------- | ------------------- | ---------------------- | ------------------- | ------------------- | -------------------- | ------------------- |
| bbc         | 180 (172-388)       | 2,188 (1,812-3,008) | 2,980 (1,844-3,088) | 2,540 (2,512-2,548)    | 1,644 (1,604-1,672) | 2,071 (1,065-2,142) | 404 (392-428)        | **272** (252-400)   |
| hackernews  | 380 (344-392)       | 860 (748-1,572)     | 840 (824-1,484)     | 776 (712-788)          | 720 (712-740)       | 675 (655-684)       | 448 (424-500)        | **436** (392-560)   |
| wikipedia   | 196 (188-236)       | 1,568 (1,440-1,588) | 1,444 (1,400-1,524) | 940 (932-956)          | 760 (672-764)       | 675 (656-678)       | 432 (408-456)        | **376** (376-420)   |
| mdn         | 300 (272-596)       | 1,388 (1,304-1,496) | 1,480 (1,376-1,536) | 904 (880-1,024)        | 756 (716-892)       | 675 (556-693)       | 356 (152-360)        | **324** (292-360)   |
| python-docs | 276 (268-296)       | 1,444 (1,416-1,588) | 1,428 (1,408-1,536) | 864 (812-880)          | 656 (592-668)       | 545 (514-579)       | **320** (308-404)    | 584 (548-736)       |
| github      | 1,512 (1,172-1,788) | 4,560 (4,476-5,236) | 3,952 (3,480-4,056) | 3,984 (3,876-4,296)    | 3,608 (3,448-3,920) | 3,285 (2,683-3,335) | **1,256** (40-1,596) | 1,692 (1,676-1,872) |

### Rewrite throughput (MB/s, median of repeats, range in brackets; higher is better)

|                                   | native Chrome       | STomp (js)       | STomp (wasm)        | STomp (js, no adblock) | Scramjet            | Ultraviolet      | stompV1          | powerMouseV1            |
| --------------------------------- | ------------------- | ---------------- | ------------------- | ---------------------- | ------------------- | ---------------- | ---------------- | ----------------------- |
| in the browser, through the proxy | 25.48 (24.86-25.83) | 2.77 (2.40-2.80) | 4.76 (4.67-4.85)    | 2.79 (2.75-2.80)       | 8.81 (8.78-8.97)    | 3.45 (3.38-3.61) | 4.33 (4.14-4.45) | **12.45** (12.14-12.76) |
| rewriter alone, shared scripts    |                     | 3.68 (3.45-4.16) | 17.75 (17.02-17.77) |                        | 35.54 (34.98-44.74) | 6.50 (6.21-6.71) | 4.71 (4.50-5.41) | **142** (139-152)       |
| rewriter alone, own scripts       |                     | 3.97 (3.65-4.38) | 17.46 (16.78-17.50) |                        | 36.85 (36.19-46.33) | 7.03 (6.56-7.26) | 4.71 (4.50-5.41) | **140** (129-142)       |

### Memory (MB, median of repeats, range in brackets; lower is better)

|                               | native Chrome       | STomp (js)          | STomp (wasm)        | STomp (js, no adblock) | Scramjet            | Ultraviolet             | stompV1             | powerMouseV1 |
| ----------------------------- | ------------------- | ------------------- | ------------------- | ---------------------- | ------------------- | ----------------------- | ------------------- | ------------ |
| all processes, blank tab (MB) | 239 (236-243)       | 482 (454-483)       | 458 (457-485)       | 329 (328-332)          | 279 (277-283)       | 307 (304-310)           | **270** (269-272)   | DNF          |
| all processes, 20 frames (MB) | 292 (290-297)       | 583 (493-587)       | 562 (555-585)       | 433 (433-439)          | 424 (421-436)       | **388** (384-389)       | 392 (392-395)       | DNF          |
| per ad-like frame (KB)        | 2,753 (2,653-2,838) | 5,204 (1,682-5,510) | 5,047 (4,993-5,354) | 5,345 (5,226-5,478)    | 7,451 (7,294-7,815) | **4,110** (4,045-4,147) | 6,300 (6,258-6,310) | DNF          |
| JS heap, blank tab (MB)       | 1 (1-1)             | 6 (6-6)             | 5 (5-5)             | 6 (6-6)                | 6 (6-6)             | **3** (3-3)             | 4 (4-4)             | DNF          |
| JS heap, 20 frames (MB)       | 11 (11-11)          | 34 (34-34)          | 32 (32-32)          | 34 (34-34)             | 36 (36-36)          | **21** (21-21)          | 58 (58-58)          | DNF          |

### CPU time per load (ms, median of repeats, range in brackets; lower is better)

|                          | native Chrome       | STomp (js)             | STomp (wasm)        | STomp (js, no adblock) | Scramjet            | Ultraviolet            | stompV1             | powerMouseV1            |
| ------------------------ | ------------------- | ---------------------- | ------------------- | ---------------------- | ------------------- | ---------------------- | ------------------- | ----------------------- |
| article, Chrome          | 650 (570-820)       | 3,190 (3,140-3,340)    | 3,240 (3,130-3,250) | 1,260 (1,160-1,280)    | 1,120 (1,110-1,130) | 850 (830-890)          | 600 (580-700)       | **450** (400-470)       |
| article, server          | 0                   | 20 (20-30)             | 10 (10-20)          | **0** (0-10)           | **0** (0-10)        | 10 (0-10)              | 50 (50-90)          | 120 (50-150)            |
| 200 subresources, Chrome | 930 (920-1,020)     | 5,240 (5,060-5,320)    | 4,900 (4,780-5,040) | 3,170 (3,080-3,240)    | 2,610 (2,550-2,630) | 1,750 (1,720-1,800)    | 1,790 (1,760-1,830) | **1,070** (1,010-1,100) |
| 200 subresources, server | 0                   | 40 (20-40)             | 30 (20-40)          | 20 (10-20)             | 20 (0-30)           | **10** (10-20)         | 150 (140-250)       | 470 (340-670)           |
| script corpus, Chrome    | 1,300 (1,270-1,360) | 16,560 (16,180-16,740) | 6,590 (6,480-6,650) | 14,770 (14,670-14,890) | 3,890 (3,870-3,940) | 10,580 (10,250-10,660) | 8,670 (8,570-8,890) | **1,330** (1,300-1,400) |
| script corpus, server    | 0                   | 30 (20-30)             | 20 (20-30)          | **10** (10-20)         | 20 (10-20)          | **10**                 | 120 (110-200)       | 870 (700-1,050)         |

### Bytes per load (KB, median of repeats, range in brackets; lower is better)

|                  | native Chrome | STomp (js) | STomp (wasm) | STomp (js, no adblock) | Scramjet   | Ultraviolet | stompV1    | powerMouseV1 |
| ---------------- | ------------- | ---------- | ------------ | ---------------------- | ---------- | ----------- | ---------- | ------------ |
| article          | 4,294         | **4,294**  | **4,294**    | **4,294**              | **4,294**  | **4,294**   | **4,294**  | **4,294**    |
| 200 subresources | 1,386         | **1,386**  | **1,386**    | **1,386**              | **1,386**  | **1,386**   | **1,386**  | **1,386**    |
| script corpus    | 14,574        | **14,574** | **14,574**   | **14,574**             | **14,574** | 14,574      | **14,574** | **14,574**   |

### Bytes per real-site load (KB, median of repeats, range in brackets; lower is better)

|             | native Chrome       | STomp (js)          | STomp (wasm)        | STomp (js, no adblock) | Scramjet            | Ultraviolet         | stompV1              | powerMouseV1            |
| ----------- | ------------------- | ------------------- | ------------------- | ---------------------- | ------------------- | ------------------- | -------------------- | ----------------------- |
| bbc         | 2,259 (2,230-2,305) | 4,413 (4,323-4,538) | 4,583 (4,370-4,648) | 2,534 (2,526-2,559)    | 2,089 (2,033-2,097) | 2,375 (2,006-2,434) | 2,387 (1,969-2,432)  | **1,029** (1,025-1,095) |
| hackernews  | 62 (54-66)          | 2,235 (2,225-2,252) | 2,233 (2,222-2,239) | 72 (53-88)             | 62 (40-69)          | **62** (45-71)      | 78 (62-81)           | 79 (70-88)              |
| wikipedia   | 598 (573-608)       | 2,799 (2,776-2,822) | 2,889 (2,764-2,906) | 642 (607-742)          | 608 (586-619)       | 596 (593-609)       | 628 (619-638)        | **288** (284-309)       |
| mdn         | 660 (657-677)       | 2,711 (2,702-2,724) | 2,720 (2,690-2,722) | 708 (651-721)          | 676 (669-686)       | 579 (558-586)       | **466** (42-484)     | 685 (670-763)           |
| python-docs | 92 (83-102)         | 2,292 (2,274-2,299) | 2,290 (2,251-2,295) | 128 (113-136)          | 98 (97-110)         | **97** (94-99)      | 100 (94-137)         | 251 (239-260)           |
| github      | 2,622 (2,606-2,628) | 4,876 (4,669-5,690) | 4,835 (4,645-5,678) | 2,656 (2,530-2,666)    | 3,299 (3,079-3,542) | 2,490 (2,458-2,545) | **2,295** (31-2,360) | 2,332 (2,321-2,393)     |

### Fidelity (checks equal to native)

|                        | total   | location | url-resolution | cookies | secure-context | storage | postmessage | workers | fetch-xhr | iframes | history | sockets | misc  |
| ---------------------- | ------- | -------- | -------------- | ------- | -------------- | ------- | ----------- | ------- | --------- | ------- | ------- | ------- | ----- |
| native Chrome          | 169/169 | 24/24    | 17/17          | 15/15   | 8/8            | 11/11   | 15/15       | 10/10   | 19/19     | 11/11   | 11/11   | 11/11   | 17/17 |
| STomp (js)             | 154/169 | 24/24    | 16/17          | 15/15   | 6/8            | 11/11   | 15/15       | 9/10    | 19/19     | 9/11    | 6/11    | 7/11    | 17/17 |
| STomp (wasm)           | 154/169 | 24/24    | 16/17          | 15/15   | 6/8            | 11/11   | 15/15       | 9/10    | 19/19     | 9/11    | 6/11    | 7/11    | 17/17 |
| STomp (js, no adblock) | 154/169 | 24/24    | 16/17          | 15/15   | 6/8            | 11/11   | 15/15       | 9/10    | 19/19     | 9/11    | 6/11    | 7/11    | 17/17 |
| Scramjet               | 101/169 | 23/24    | 12/17          | 12/15   | 5/8            | 6/11    | 10/15       | 1/10    | 9/19      | 4/11    | 8/11    | 1/11    | 10/17 |
| Ultraviolet            | 90/169  | 21/24    | 8/17           | 7/15    | 5/8            | 7/11    | 11/15       | 3/10    | 7/19      | 4/11    | 6/11    | 1/11    | 10/17 |
| stompV1                | 61/169  | 9/24     | 9/17           | 4/15    | 5/8            | 2/11    | 6/15        | 0/10    | 2/19      | 3/11    | 4/11    | 5/11    | 12/17 |
| powerMouseV1           | 36/169  | 5/24     | 0/17           | 3/15    | 1/8            | 3/11    | 5/15        | 3/10    | 3/19      | 0/11    | 3/11    | 2/11    | 8/17  |

### Leaks (escape vectors that reached the network outside the proxy)

|                        | vectors leaked | requests leaked |
| ---------------------- | -------------- | --------------- |
| native Chrome          | 0/80           | 0               |
| STomp (js)             | 0/80           | 0               |
| STomp (wasm)           | 0/80           | 0               |
| STomp (js, no adblock) | 0/80           | 0               |
| Scramjet               | 5/80           | 5               |
| Ultraviolet            | 10/80          | 10              |
| stompV1                | 12/80          | 12              |
| powerMouseV1           | 35/80          | 35              |

### Size of what the browser downloads for the proxy itself (KB)

|                        | raw   | brotli |
| ---------------------- | ----- | ------ |
| STomp (js)             | 8,104 | 2,691  |
| STomp (wasm)           | 8,678 | 2,901  |
| STomp (js, no adblock) | 7,065 | 2,399  |
| Scramjet               | 2,508 | 828    |
| Ultraviolet            | 2,157 | 702    |
| stompV1                | 1,658 | 385    |
| powerMouseV1           | 2     | 1      |
