#!/usr/bin/env python
"""
jobscrape <-> Scrapling bridge. Reads one JSON request on stdin, writes one JSON response on stdout.

request: {
  "mode": "http" | "stealth" | "dynamic",      http = curl_cffi with browser TLS fingerprint; stealth = Camoufox (modified Firefox); dynamic = Playwright Chromium
  "urls": ["https://..."],                     fetched sequentially in ONE session (cookies persist across them)
  "headless": true, "network_idle": false, "wait_selector": null, "timeout_ms": 60000,
  "impersonate": "chrome", "proxy": null, "block_images": true,
  "extract": { "name": { "css": "li.job", "fields": { "title": "h2::text", "url": "a::attr(href)" } } }   optional cheap server-side extraction
}
response: { "pages": [ { "url", "final_url", "status", "title", "html" | "items" } ], "error"?: str }
"""
import json, sys, traceback

def main():
    req = json.load(sys.stdin)
    mode = req.get("mode", "stealth")
    urls = req.get("urls") or [req["url"]]
    headless = req.get("headless", True)
    out = {"pages": []}
    try:
        if mode == "http":
            from scrapling.fetchers import FetcherSession
            with FetcherSession(impersonate=req.get("impersonate", "chrome"), proxy=req.get("proxy"), stealthy_headers=True) as s:
                for u in urls:
                    page = s.get(u, timeout=req.get("timeout_ms", 60000) / 1000)
                    out["pages"].append(pack(u, page, req))
        elif mode == "stealth":
            from scrapling.fetchers import StealthySession
            kw = dict(headless=headless, network_idle=req.get("network_idle", False),
                      block_images=req.get("block_images", True), timeout=req.get("timeout_ms", 60000))
            if req.get("proxy"): kw["proxy"] = req["proxy"]
            with StealthySession(**kw) as s:
                for u in urls:
                    page = s.fetch(u, wait_selector=req.get("wait_selector"))
                    out["pages"].append(pack(u, page, req))
        else:
            from scrapling.fetchers import DynamicSession
            kw = dict(headless=headless, network_idle=req.get("network_idle", False), disable_resources=req.get("block_images", True), timeout=req.get("timeout_ms", 60000))
            if req.get("proxy"): kw["proxy"] = req["proxy"]
            with DynamicSession(**kw) as s:
                for u in urls:
                    page = s.fetch(u, wait_selector=req.get("wait_selector"))
                    out["pages"].append(pack(u, page, req))
    except Exception as e:  # noqa
        out["error"] = f"{type(e).__name__}: {e}"
        out["trace"] = traceback.format_exc()[-2000:]
    json.dump(out, sys.stdout)

def pack(u, page, req):
    res = {"url": u, "final_url": getattr(page, "url", u), "status": getattr(page, "status", None)}
    try: res["title"] = page.css("title::text").get()
    except Exception: res["title"] = None
    ex = req.get("extract")
    if ex:
        res["items"] = {}
        for name, spec in ex.items():
            rows = []
            for el in page.css(spec["css"], adaptive=spec.get("adaptive", False), auto_save=spec.get("auto_save", False)):
                row = {}
                for f, sel in spec.get("fields", {}).items():
                    try: row[f] = el.css(sel).get() if sel else None
                    except Exception: row[f] = None
                for f, attr in spec.get("attrs", {}).items():
                    row[f] = el.attrib.get(attr)
                rows.append(row)
            res["items"][name] = rows
    else:
        res["html"] = page.html_content
    return res

if __name__ == "__main__":
    main()
