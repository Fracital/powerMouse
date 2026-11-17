### Security

- Speculation rules no longer reach the browser: a `Speculation-Rules`
  header and a `<script type="speculationrules">` (in the markup, inserted,
  written or set) had the browser prefetch and prerender the URLs they
  named straight from the sites, past the proxy. The browser gets an empty
  rule set; the page still reads its own rules back. (speculation-rules
  suite.)
