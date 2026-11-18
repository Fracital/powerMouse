### Fidelity

- A page whose policy governs its workers with a list that has
  'strict-dynamic' (a script-src, default-src, child-src or worker-src)
  starts every worker it makes, a blob: or data: one included, as
  natively: a worker is no parser's script, so Chrome lets it through
  whatever else the list says. The browser's copy of such a policy kept
  only 'self', and the worker judged the hosts, so the worker was refused
  and reported (Bing Maps' blob: tile workers under its script-src with
  'strict-dynamic': the map stayed blank). (csp-fetch suite.)
