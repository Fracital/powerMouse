# Vendored web-platform-tests

A bounded subset of [web-platform-tests](https://github.com/web-platform-tests/wpt)
(BSD 3-Clause, see `LICENSE.md`), run through the proxy by the `wpt-cookies`,
`wpt-fetch-metadata` and `wpt-referrer-policy` suites as measurements: every
page runs natively from the fixture and again inside a proxied frame, and
`test/wpt.mjs` compares the two testharness verdicts per subtest against the
expected-failure list in `expected/<suite>.json`.

Upstream commit: `cbd1ca1e57141617f5434bd8137d9758f046a61e` (2026-11-07).

## What is here

| Directory                  | Files | What                                                                                                          |
| -------------------------- | ----- | ------------------------------------------------------------------------------------------------------------- |
| `resources/`               | 4     | `testharness.js`, `testdriver.js` (upstream); `testharnessreport.js`, `testdriver-vendor.js` (ours, below)    |
| `common/`                  | 4     | `get-host-info.sub.js`, `utils.js`, `blank.html`, `security-features/resources/common.sub.js`                 |
| `cookies/`                 | 47    | attributes, encoding, name, ordering, path, prefix, size, value, the http `secure/` tests, the top-level ones |
| `fetch/metadata/`          | 35    | the generated `*.https.sub.html` matrix, `fetch.https.sub.any.js`, `fetch-preflight.https.sub.any.js`         |
| `referrer-policy/generic/` | 51    | the hand-written tests (inheritance, subresource-test, resources)                                             |
| `referrer-policy/gen/`     | 310   | `top.http-rp`, `top.meta` and `req.attr`, `.http.html` sources, nine subresource kinds                        |

`test/wpt-server.mjs` serves the tree at the WPT paths the tests hard-code and
ports what wptserve would do: `.sub.` template substitutions (`{{host}}` is
`localhost`, the same-site hosts `www.localhost`, the cross-site hosts
`127.0.0.1`, every port the fixture's, `https` collapsed to `http`: localhost
is a secure context, so the trustworthy-origin cases keep their meaning;
Chrome treats `www.localhost` as cross-site to `localhost`, so the same-site
cases fail natively and drop out of the comparison),
`.headers` sidecars, `.any.html` / `.window.html` wrappers, and the python
handlers the vendored tests call (`cookies/resources/{cookie,set-cookie,set,
drop,list,echo-json}.py`, `fetch/metadata/resources/{record-headers,
echo-as-json}.py`, `fetch/api/resources/redirect.py`,
`common/security-features/subresource/{xhr,document,script,worker,image,
empty,static-import}.py` with the redirection and stash actions,
`referrer-policy/generic/resources/{referrer,refresh-policy}.py`).

Ours, not upstream:

- `resources/testharnessreport.js` doubles the harness timeout (the proxied
  path is slower; the native run gets the same budget) and posts each page's
  results to the fixture's `/_wpt/report`, keeping a copy on
  `window.__wptResults`.
- `resources/testdriver-vendor.js` has no WebDriver: `delete_all_cookies`
  expires what `document.cookie` can see (own path, ancestors, root), `click`
  is a synthetic click, so `test_driver.bless()` runs its action without user
  activation and the "user activated" cases fail natively instead of waiting.

## What was left out, and why

- `cookies/domain`, `cookies/samesite*`, `cookies/schemeful-same-site`,
  `cookies/partitioned-cookies`, `cookies/third-party-cookies`,
  `cookies/origin-bound-cookies`: need https, several registrable domains or
  ports, and the SameSite python handlers.
- `cookies/secure/*.https.*` and `set-from-ws(s)`: a secure page or a
  WebSocket that sets cookies (the proxy does not apply WebSocket
  `Set-Cookie` by design).
- `*.https.html` / `*.https.window.js` under cookies: tests that must fail
  over http.
- `fetch/metadata/generated/{serviceworker,fetch-via-serviceworker,
audioworklet}`: a service worker or a worklet behind the request.
- `fetch/metadata/generated/{element-link-prefetch,element-meta-refresh,
header-refresh}` (optional, seconds per case) and `header-link` (needs
  `header-link.py`).
- `fetch/metadata/*.html` top-level tests and `redirect/`: `record-header.py`
  with media payloads, `trailing-dot` hosts, CSP reports.
- `referrer-policy/gen/{iframe,srcdoc,srcdoc-inherit,iframe-inherit,
iframe-data-inherit,worker-classic,worker-module}.*` and every
  `.https.html`: 7 MB more of the same matrix; the top-level and attribute
  deliveries already exercise each proxy code path (document header, meta
  tag, element attribute, each subresource kind).
- `referrer-policy/gen/*/{sharedworker-*,svg-a-tag,mathml-a-tag}`: more pages
  without another proxy path.
- `referrer-policy/4K*`: the 4 KiB Referer boundary needs `history.pushState`
  to a long URL on the top-level page.
- `referrer-policy/generic/iframe-upgrade-request-to-*`: upgrade-insecure
  requests need an https origin.
- `referrer-policy/generic/inheritance/popup-*` and `workers.html`: popups
  without activation, a service worker.

## State of the expected lists

Measured 2026-11-07 (same-origin mode). `expected/wpt-cookies.json` and
`expected/wpt-fetch-metadata.json` come from complete runs.
`expected/wpt-referrer-policy.json` is partial in effect: its run finished,
but 72 of the 276 pages reported nothing within 30 s through the proxy under
three concurrent controller pages, and the same pages reported in a second
when loaded alone, so those entries record a stall under load, not a verdict.
The second pass re-measures it with `WPT_CONCURRENCY=1`.

## Running and refreshing

```sh
npm test -- wpt-cookies wpt-fetch-metadata wpt-referrer-policy
UPDATE_EXPECTED=1 npm test -- wpt-cookies   # rewrite expected/wpt-cookies.json
```

The suites are measurements (`SKIP_MEASUREMENT=1` leaves them out, as CI
does). A proxied failure not on the list fails the suite; so does a listed
failure that now passes, so a fix comes with its expected list trimmed.
Every page starts with an empty cookie jar in both modes and has 30 s to
report; a page that does not is a failure with the cause `timeout`.
`WPT_ONLY=<regex>` runs a few pages for a look, `WPT_CONCURRENCY=<n>` sets how
many load at once (the cookie pages share the jar and run one at a time).

To refresh from upstream:

```sh
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/web-platform-tests/wpt /tmp/wpt
git -C /tmp/wpt sparse-checkout set resources cookies fetch/metadata referrer-policy common
node test/wpt/refresh.mjs /tmp/wpt
```

`refresh.mjs` holds the include and exclude lists, copies the files (the
checkout is data: nothing in it runs) and prints the upstream commit to put
in this file. Then rerun the three suites with `UPDATE_EXPECTED=1` and review
the diff of `expected/`.
