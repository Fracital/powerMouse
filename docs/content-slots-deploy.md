# stomp.fracit.al: the four content slot ports (prepared, not applied)

**Status: prepared only. Nothing here was applied.** No DNS, Cloudflare,
divide, edge, firewall, certificate, deploy-gate or `.env` change was made
from this repository. This is for the infra owner (`~/src/infra`, the
abulxt/Fracital ansible). Every infra path below was read at infra HEAD
`d7a3683` (2026-11-20); check them against HEAD on the day.

What the ports are for, and what they are not, is docs/content-slots.md:
dialing (`?mode=just-call-stomp`) writes every proxied page into a call
page on another port of stomp.fracit.al, so powerMouse's UI on 443 and the
pages are different origins, agent clusters and processes. The ports are
not a cookie boundary and not a sandbox.

## 0. When, and what changes for users

- Apply only once the content slots have landed and been deployed (the
  app reads `STOMP_SLOT_PORTS_PUBLIC`, section 5). Sections 1 to 4 can be
  staged before: nothing uses the ports until the `.env` line exists.
- Only the dialing mode uses the ports. The default (navigated) mode, the
  UI on 443, the wisp relay and every other Fracital name are unchanged.
- A browser that cannot reach the ports (a filter that lets 443 through
  alone) is unaffected: the page finds the slots silent and writes the
  pages on 443's origin, as today.

## 1. The ports: Cloudflare decides

stomp.fracit.al is a proxied CNAME to byod.fracit.al
(inventory/group_vars/all/fracital.yml, `fracital_extra_hosts`;
docs/divide-host.md: the proxied names resolve to Cloudflare). Cloudflare
proxies HTTPS only on 443, 2053, 2083, 2087, 2096 and 8443. 443 is the UI
and 8443 is dev.fracit.al's path at the origin (divide DNATs tcp 8443 to
terp directly), which leaves exactly four:

| port | protocol         | carries                           |
| ---- | ---------------- | --------------------------------- |
| 2053 | TCP, TLS (HTTPS) | content slot 1 of stomp.fracit.al |
| 2083 | TCP, TLS (HTTPS) | content slot 2                    |
| 2087 | TCP, TLS (HTTPS) | content slot 3                    |
| 2096 | TCP, TLS (HTTPS) | content slot 4                    |

No UDP (no wisp, no HTTP/3 on the slots: the transport stays in the UI's
page on 443). No new certificate (one names a host, not a port; auto-ssl
picks stomp.fracit.al's by SNI on any port). No DNS change. None of the
four is in divide's `divide_nat` table or the edge's `201.fw` today.

The app registers a slot's service worker only when a site is first shown
from it, so a port no one uses costs nothing beyond its listener.

## 2. divide: forward the ports to the edge

`table ip divide_nat` (docs/divide-host.md, "DNAT of the public
address"), next to `tcp 53, 80, 443, 8080 -> edge 172.16.5.10`:

```
tcp dport { 2053, 2083, 2087, 2096 } dnat to 172.16.5.10
```

The forward chain already accepts `ct status dnat`. Update the doc's
table.

## 3. Edge guest firewall (CT 201, pve-firewall on divide)

`/etc/pve/firewall/201.fw`, beside the tcp 53, 80, 443, 8080 rule:

```
IN ACCEPT -p tcp -dport 2053,2083,2087,2096 -log nolog
```

Update docs/divide-host.md "Guest firewalls": edge (201) becomes tcp 53,
80, 443, 8080, 2053, 2083, 2087, 2096 and udp 53, 443. If terp's ufw only
admits Cloudflare on 8443 (roles/fracital_origin), nothing changes there:
the edge relays the slots to terp's 443 as it relays the UI.

## 4. Edge OpenResty: one server for the four ports

`inventory/group_vars/all/fracital.yml`:

```yaml
# STomp's content slots (STomp docs/content-slots.md): the same app on more
# ports of its name, each a separate origin to the browser. Only
# Cloudflare's HTTPS ports pass its proxy. terp's .env lists the same ports
# (STOMP_SLOT_PORTS_PUBLIC).
fracital_stomp_slot_host: stomp.fracit.al
fracital_stomp_slot_ports: [2053, 2083, 2087, 2096]
```

`roles/edge_relay/templates/fracital-routes.conf.j2`, after the Fracital
app server:

```nginx
{% if fracital_stomp_slot_ports | default([]) | length > 0 %}

# stomp.fracit.al's content slots: the same app as on 443, one origin per
# port, relayed to terp like 443 with the port the browser asked
# (X-Forwarded-Port), which the app reads to answer as that slot.
server {
{% for port in fracital_stomp_slot_ports %}
    listen {{ port }} ssl;
    listen [::]:{{ port }} ssl;
{% for ip in edge_advertise_ips_fracital | default([]) %}
    listen {{ ip }}:{{ port }} ssl;
{% endfor %}
{% for ip in edge_advertise_ips_v6_fracital | default([]) %}
    listen [{{ ip }}]:{{ port }} ssl;
{% endfor %}
{% endfor %}
    http2 {{ 'on' if (openresty_http2 | default(false) | bool) else 'off' }};
    server_name {{ fracital_stomp_slot_host }};

    ssl_certificate_by_lua_block {
        auto_ssl_instance:ssl_certificate()
    }
    ssl_certificate {{ openresty_auto_ssl_dir }}/fallback.crt;
    ssl_certificate_key {{ openresty_auto_ssl_dir }}/fallback.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    client_max_body_size {{ fracital_client_max_body_size }};

    location / {
        include {{ openresty_conf_dir }}/snippets/fracital-origin.conf;
        proxy_set_header X-FRX-App "";
        proxy_set_header X-Forwarded-Port $server_port;
        proxy_buffering off;
        proxy_read_timeout {{ fracital_proxy_timeout }};
        proxy_send_timeout {{ fracital_proxy_timeout }};
    }
}
{% endif %}
```

- Copy the TLS settings from the 443 server of the day rather than this
  sketch. If `edge_front_listen` fronts 443 with a socket, decide whether
  the slot ports need the same arrangement.
- **Hardening (do it with the above):** in the 443 server's `location /`
  (and the asset location) add `proxy_set_header X-Forwarded-Port 443;`,
  so a client cannot claim on the UI's port to be a slot. The app trusts
  the header only for the ports `STOMP_SLOT_PORTS_PUBLIC` lists.
- terp's app vhost (roles/fracital_origin, `fracital_origin_apps` stomp)
  sets no `X-Forwarded-Port`, so nginx passes the edge's on to the app
  unchanged; keep it that way (or set
  `proxy_set_header X-Forwarded-Port $http_x_forwarded_port;` there to say
  so).
- **Headers:** nothing on the path (Cloudflare rules, the edge, terp) may
  add `X-Frame-Options` or a CSP `frame-ancestors` to stomp responses (the
  UI on 443 frames the slots, which is cross-origin), or strip or rewrite
  `Origin-Agent-Cluster` (the app sends `?1` on every slot response; an
  origin's keying is decided by its first document in the tab, so every
  response of a slot must carry it). Neither is done for stomp today.
- The keyed wisp path is not needed on the slot ports.
- Cloudflare: the same zone settings apply on the four ports (SSL mode
  Full as today). No page rule, cache rule or Worker is needed;
  `/config.js` is `no-store`. An alternative that leaves divide and the
  edge alone is a Cloudflare Origin Rule that sends ports 2053, 2083,
  2087 and 2096 to the origin's 443 with a request header Transform Rule
  setting `X-Forwarded-Port` dynamically to
  `to_string(cf.edge.server_port)` on every port, 443 included; then
  sections 2 to 4 are not needed, but the edge's 443 server must pass that
  header instead of setting it. Pick one, not both.

## 5. terp: the app's environment

`/opt/stomp/repo/.env` (CT 216), one line:

```
STOMP_SLOT_PORTS_PUBLIC=2053,2083,2087,2096
```

then `pm2 restart stomp --update-env` (as the deploy user's sudo rules
allow, or by hand as root).

- Leave `STOMP_SLOT_PORTS` unset: it makes the app bind ports itself,
  which is for running without a front. Behind the edge everything arrives
  on 8081.
- `STOMP_SITE_POOL_PUBLIC` is the navigated mode's site pool, a separate
  product decision. If it is ever set too, its ports must not be these.
- `STOMP_PROXY_ORIGIN` (navigated isolation mode) is independent; a page
  served with it does not dial.
- No deploy-gate change: the line survives deploys like the others.

Rollback: remove the line and restart. Dialed tabs write their pages on
443's origin again. The divide, firewall and edge rules can stay; nothing
uses them without the line.

## 6. Verification (read-only)

```sh
for p in 2053 2083 2087 2096; do
  # the slot answers with stomp's certificate, through Cloudflare
  curl -s -o /dev/null -w "$p %{http_code} %{ssl_verify_result}\n" \
    "https://stomp.fracit.al:$p/api/status?x=$RANDOM"          # 200 0
  # every slot response asks for its own agent cluster
  curl -sI "https://stomp.fracit.al:$p/stomp/controllerFrame.html" |
    grep -i '^origin-agent-cluster'                              # ?1
  # and nothing blocks framing it
  curl -sI "https://stomp.fracit.al:$p/" | grep -ci '^x-frame-options'  # 0
done
# the UI's own origin does not ask for one, even when a client claims a slot
curl -sI -H 'X-Forwarded-Port: 2053' "https://stomp.fracit.al/stomp/controllerFrame.html" |
  grep -ci '^origin-agent-cluster'                               # 0 (with the hardening)
# the page hands the ports to the dialing mode
curl -s "https://stomp.fracit.al/config.js?x=$RANDOM" |
  grep -o '"contentSlots":\[[0-9,]*\]'                           # [2053,2083,2087,2096]
```

On the edge: `openresty -t`, then `ss -ltn | grep -cE ':(2053|2083|2087|2096) '`
(4 times the listen addresses). On divide: `nft list table ip divide_nat |
grep 2053` and `pve-firewall compile 2>/dev/null | grep -c 2053`.

In a browser: open `https://stomp.fracit.al/?mode=just-call-stomp`, visit
a site, and check that the tab's iframe `src` is
`https://stomp.fracit.al:<one of the ports>/<dial directory>/<dial page>`
(the server's minted names, `STOMP_CONFIG.dial`), that
`chrome://process-internals` lists that origin as origin-keyed, that
DevTools' Application panel shows a service worker only on the ports a
site was shown from, and that with the `.env` line removed the same visit
works with the iframe on the same path of `https://stomp.fracit.al`.
