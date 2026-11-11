# The HTTP cache against Chrome's

The service worker has an HTTP cache in front of the transport
(`src/server/cache.ts`, `cache: false` turns it off). A site sees it two
ways: in what its origin is asked (nothing, a conditional request, the whole
resource again) and in what resource timing says of a load. Both are meant
to read as they do in Chrome, so the cache keeps what Chrome's HTTP cache
keeps and asks the origin when Chrome's does. This file is the table that
was measured, and the one difference kept on purpose.

## How it is measured

`test/pages/http-cache.html` fetches one URL three times under each shape
of caching headers (some shapes four times, some as a document in a frame),
and the fixture (`/http-cache` in `test/fixture.mjs`) logs what each request
asked of it: its status, its method when not GET, and the conditional,
cache and range headers the request carried. The http-cache suite loads the page natively and through the proxy
in both demo modes and compares each shape's report: what the origin was
asked at each fetch, and what the page got. Chrome 152 and 156 give the
same table. `HC_ONLY=<text>` runs the shapes whose name has the text,
`HC_PRINT=1` prints the native report.

In the tables, "not asked" means the cache answered, "304" that the origin
was sent the entry's validator (`If-None-Match`, or `If-Modified-Since` for
a Last-Modified alone) and confirmed it, and "fetched" that the origin was
asked for the resource with no condition and sent it again.

## What a response's headers make of the next fetch

| The response                                                           | The next fetches      |
| ---------------------------------------------------------------------- | --------------------- |
| `max-age=3600`                                                         | not asked             |
| `max-age=3600, immutable`                                              | not asked             |
| `max-age=3600, must-revalidate` (it is about a stale entry)            | not asked             |
| `private, max-age=3600`                                                | not asked             |
| `s-maxage=0, max-age=3600` (s-maxage is for shared caches)             | not asked             |
| `s-maxage=3600` alone                                                  | fetched               |
| `public` alone                                                         | fetched               |
| `Expires` an hour ahead                                                | not asked             |
| `max-age=3600` beside an `Expires` in the past                         | not asked             |
| `Expires` in the past, or `Expires: 0`, with an ETag                   | 304                   |
| `no-cache` with an ETag                                                | 304                   |
| `no-cache` with a Last-Modified                                        | 304                   |
| `no-cache, max-age=3600` with an ETag                                  | 304                   |
| `no-cache` without a validator                                         | fetched               |
| `no-cache="set-cookie", max-age=3600` (about that header only)         | not asked             |
| `Pragma: no-cache` with an ETag                                        | 304                   |
| `Pragma: no-cache` beside `max-age=3600`                               | fetched               |
| `no-store`, with an ETag or with `max-age=3600`                        | fetched               |
| `private` with an ETag                                                 | 304                   |
| `max-age=0` with an ETag                                               | 304                   |
| `max-age=0` without a validator                                        | fetched               |
| `must-revalidate` alone with an ETag                                   | 304                   |
| `max-age=1` with an ETag, two seconds on (with must-revalidate too)    | 304                   |
| `max-age=1` without a validator, two seconds on                        | fetched               |
| `max-age=1, stale-while-revalidate=60` with an ETag, two seconds on    | the entry, and a 304  |
| `max-age=1, stale-if-error=60`, two seconds on, the origin answers 500 | the 500               |
| `max-age=60` with an `Age` of 50 and an ETag                           | not asked, 304 after  |
| an ETag and nothing else                                               | 304                   |
| a Last-Modified ten days ago and nothing else (a tenth of its age)     | not asked             |
| a Last-Modified ten days ago and an ETag                               | not asked             |
| a Last-Modified 200 s ago: within 20 s, then after                     | not asked, then 304   |
| no caching header at all                                               | fetched               |
| `max-age=3600`, no Content-Length                                      | not asked             |
| `max-age=3600` with a Set-Cookie                                       | not asked             |
| `max-age=3600, Vary: *`                                                | fetched               |
| `max-age=3600, Vary: *` with an ETag                                   | 304                   |
| `max-age=3600, Vary: accept-encoding`                                  | not asked             |
| `max-age=3600`, Vary on a header the requests send alike               | not asked             |
| `max-age=3600`, Vary on a header each request sends differently        | fetched               |
| the same with an ETag (the entry's validator goes with the request)    | 304                   |
| `max-age=3600`, the requests with one cookie, or one Authorization     | not asked             |
| `max-age=3600, Vary: Cookie`, another cookie each time                 | fetched               |
| `public, max-age=3600`, another cookie each time                       | not asked             |
| `max-age=3600` (or `private, max-age=3600`), another cookie each time  | not asked (see below) |

By status: a 200 or a 203 gets the Last-Modified heuristic; a 300, 301, 308
or 410 with nothing else is kept, a 302 or a 404 with nothing
else is fetched; with `max-age=3600` a 302, 303, 307, 403, 404, 500 or 503
is not asked for again; a 204 and a 401 are never kept. Only a 200 is ever
revalidated: a stale 404 with an ETag is fetched, not confirmed.

A cookie a 304 sets is set, also by a revalidation that runs behind the
page.

## What a request's cache mode makes of an entry

| The request, to a `max-age=3600` entry unless said                                                            | Chrome                                                                                               |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `cache: 'no-store'`                                                                                           | fetched with `Cache-Control: no-cache`, `Pragma: no-cache`; the entry stays                          |
| `cache: 'reload'`                                                                                             | fetched with the same headers; the answer replaces the entry                                         |
| `cache: 'no-cache'`                                                                                           | fetched with `Cache-Control: max-age=0` (a 304 when the entry has an ETag)                           |
| `cache: 'force-cache'`, to a stale or a `no-cache` entry, or to one with neither a validator nor time to live | not asked                                                                                            |
| `cache: 'force-cache'`, to an entry made for other Vary values                                                | fetched                                                                                              |
| `cache: 'only-if-cached'`                                                                                     | not asked; a network error when nothing is kept                                                      |
| the page's own `If-None-Match`                                                                                | sent as written with `Cache-Control: max-age=0`; the page gets the 304 or the body; the entry stays  |
| the page's own `Cache-Control: no-cache`                                                                      | fetched as written; the answer replaces the entry                                                    |
| a HEAD                                                                                                        | not asked; the entry's status and headers, no body                                                   |
| a HEAD first, then GETs                                                                                       | the HEAD's answer is not kept: the first GET is fetched                                              |
| a `Range` of the entry's bytes (`bytes=0-0`)                                                                  | not asked; a 206 of those bytes                                                                      |
| a `Range` first, then GETs, to a `max-age=3600` with an ETag                                                  | the next GET confirms the kept bytes and asks for the rest (see Parts); the GETs after are not asked |
| a `Range` of the kept part's bytes, each time                                                                 | not asked while fresh; once stale, `If-None-Match` with the `Range`, and a 304                       |
| a `Range` of the last byte first, then GETs                                                                   | see Parts: the next two GETs are fetched, the one after is not asked                                 |
| a `Range` first, the 206 with no validator                                                                    | the 206 is not kept: the next GET is fetched                                                         |
| a document, loaded again in another frame                                                                     | as a fetch                                                                                           |
| a document, reloaded                                                                                          | as `no-cache`: `Cache-Control: max-age=0`, a 304 when it has a validator                             |

Chrome hands the worker a request with a conditional header of the page's
as `cache: 'no-cache'`, and a reloaded document's too; the forward
(`genericForward` in `src/server/rewrites.ts`) reads the mode from both.
The conditional headers Chrome adds for what its memory cache holds (a
script, an image) are dropped before: those loads are the worker's
MemoryCache's.

## A reload of the host's tab

Natively a reload has the origin confirm the document (the row above) and
a hard reload (Ctrl+Shift+R) fetches the document and everything it loads
until its load event past the caches, with `Cache-Control: no-cache` and
`Pragma: no-cache`. Through the proxy the tab's reload reloads the host
page, which then shows its page again with a new navigation, and the
worker's caches would answer it: a page that is fresh, by `max-age` or by
its Last-Modified, could not be refreshed by any reload. So the controller
finds out how its host page was loaded (`src/controller/hostReload.ts`)
and tells the worker once, and the top-level navigations of the next ten
seconds take that mode: `no-cache` for the document after a reload,
`reload` for the document and what it loads (for thirty seconds: the
worker does not hear of the load event) after a hard one. The reload
button of a host that calls `frame.reload()` is a reload of the frame
itself and needs none of this.

A reload is the host's navigation entry. A hard reload reads the same
there, but Chrome loads the frames a hard-reloaded document creates before
its load event as hard reloads too, and a frame's own navigation entry
says so: the controller module frames an empty srcdoc document when it
loads and reads its entry's type, `reload` after a hard reload and
`navigate` otherwise (Chrome 152 and 156). A host that loads the
controller after its own load event learns of reloads only.

This is what makes the Last-Modified heuristic safe to have. It was left
out before by decision (9a5d5eb2 says "No heuristic freshness" and no
more): the worker's cache did not look at the request's cache mode then,
so a page kept on a lifetime its origin never stated could be served
where Chrome would have asked, and stayed until `clearCache()`. Now every
way Chrome refreshes such a page does here: the http-cache suite shows a
heuristically fresh document again (not asked), reloads it in its frame,
reloads the tab (both a 304), and hard-reloads the tab (fetched, with the
image in it), natively and through both modes.

## Clear-Site-Data

`Clear-Site-Data: "cache"` (or `"*"`) from a secure origin drops what is
kept of that origin, in every partition and in the worker's memory cache,
and the response that carries it is not kept. `"cookies"` leaves the cache
alone. The header's other types are not acted on, and it does not reach
the browser.

## Parts

A 206 with a strong validator (an ETag that is not weak, or a
Last-Modified) and the resource's size in its Content-Range is kept as a
part of the resource: the bytes it holds, under the resource's key, as
Chrome keeps a sparse entry. A 206 without one is not kept. A request is
then given what the part holds, with the origin asked only for the rest:

- the bytes it holds, fresh: from the part, the origin not asked;
- any other request that shares bytes with it: those bytes confirmed
  first (the validator with a `Range` of them; a 304), then the bytes it
  lacks after them asked for (a `Range` of them, `If-Range` with the
  validator). The bytes put together are kept, as the whole response once
  they make it, which the next request is given unasked;
- a request that needs bytes before the part: the bytes before it asked
  for (`Range`, `If-Range`), then the part dropped and the request sent
  as the page made it, and that answer not kept either, so the next one
  is fetched too (what Chrome 152 and 156 do);
- an answer that does not fit (a 200, another version, other bytes than
  asked): the 200 answers the request, anything else is fetched again as
  the page asked.

A range of a whole kept 200 is a 206 of its bytes, from the entry.

## stale-if-error

Not honoured, as in Chrome: a stale entry does not answer for a 5xx or a
failed request, whatever window the origin gave (cache-stale and
http-cache suites).

## The difference kept on purpose

The http-cache suite lists it with what the proxy does (`KNOWN_BY_REASON`).

1. **Other credentials.** Chrome hands an entry made for a request with one
   cookie to a request with another. Here an entry made for a request with
   credentials (a Cookie or an Authorization header) is given to a request
   with other credentials only once the origin has confirmed it (a 304 to
   its validator), and is fetched again when it has no validator, unless
   the response said `public`. The entry keeps a digest of the credentials,
   not the credentials. The digest is of the header the worker sends, which
   it builds from the jar for each request, so it follows the jar whoever
   wrote it: the page's script, a response, the host (`cookies.set`,
   `cookies.clear`), a page in another tab (the suite's credentials rows).
   The proxy's cache outlives what a site takes for a session, and the
   controllers of a scope are the tabs of one browser: one jar, one cache,
   kept per network partition (top-level site and frame site;
   sop-partitions checks that a `no-cache` entry's validator never goes
   with another partition's request).

Not measured, and as before: an entry is at most 5 MB of a 50 MB store,
the oldest going first; a request for several ranges, or for one past
the end, is given the whole entry; a range of an entry with a
Content-Encoding is of the decoded bytes.

## Where it is

| Piece                    | Where                                                                |
| ------------------------ | -------------------------------------------------------------------- |
| what is kept             | `isCacheable` in `src/server/cache.ts`                               |
| a part (206)             | `isPartCacheable`, `putPart`, and `completePart` in `genericForward` |
| how long it is fresh     | `freshnessLifetime`, `alwaysRevalidated`                             |
| what a request is given  | `HttpCache.match` (`CacheHit`)                                       |
| the request's cache mode | `genericForward`, at the HTTP cache                                  |
| a reload of the host     | `src/controller/hostReload.ts`                                       |
| Clear-Site-Data          | `clearsCache`, `clearOrigin`                                         |
| the rewrite cache's rule | `mayKeep` (not this table: its own)                                  |
