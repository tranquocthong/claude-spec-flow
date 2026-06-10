"""Response-assertion grammar for an `expect` block.

Supported keys:
  status                 exact HTTP status
  body_contains          substring (or list) present in the raw response body
  body_not_contains      substring (or list) absent from the raw body
  json_path              expr (or list) evaluated against the parsed JSON body
  body:                  object/array matchers (below)

Under `body:` (object response — Spring Page envelope):
  <field>: value         exact equality on a top-level field
  content: []            body.content is empty
  content_length: N      len(body.content) == N
  content_all_match: {}  every item in body.content matches all keys
  content_contains: [{}] for each pattern, ≥1 item in body.content matches

Under `body:` (bare top-level JSON array):
  root_length: N         len(body) == N
  root_all_match: {}     every item in body matches all keys
  root_contains: [{}]    for each pattern, ≥1 item in body matches
"""
from . import jsonpath


def _expand_pat(pat, varstore):
    return {k: (varstore.expand(v) if isinstance(v, str) else v) for k, v in pat.items()}


def _all_match(items, pattern, label, errs, varstore):
    pat = _expand_pat(pattern, varstore)
    if not items:
        errs.append(f"{label}: collection is empty — nothing to match against")
        return
    for i, item in enumerate(items):
        for k, v in pat.items():
            if not (isinstance(item, dict) and jsonpath.cmp(item.get(k), "==", v)):
                got = item.get(k) if isinstance(item, dict) else item
                errs.append(f"{label}: item[{i}].{k} expected {v!r} got {got!r}")


def _contains(items, patterns, label, errs, varstore):
    for pi, pat in enumerate(patterns):
        p = _expand_pat(pat, varstore)
        if not any(isinstance(it, dict) and all(jsonpath.cmp(it.get(k), "==", v) for k, v in p.items())
                   for it in items):
            errs.append(f"{label}[{pi}]: no item matched pattern {p}")


def assert_body(expected, actual, varstore):
    errs = []
    if not isinstance(expected, dict):
        return errs
    is_dict = isinstance(actual, dict)
    is_list = isinstance(actual, list)
    for key, val in expected.items():
        if key == "content_length":
            n = len(actual.get("content", [])) if is_dict else -1
            if n != val:
                errs.append(f"content_length: expected {val} got {n if n >= 0 else 'non-object body'}")
        elif key == "content" and val == []:
            content = actual.get("content") if is_dict else None
            if content != []:
                errs.append(f"content: expected empty list got {content!r}")
        elif key == "content_all_match":
            _all_match(actual.get("content", []) if is_dict else [], val, "content_all_match", errs, varstore)
        elif key == "content_contains":
            _contains(actual.get("content", []) if is_dict else [], val, "content_contains", errs, varstore)
        elif key == "root_length":
            n = len(actual) if is_list else -1
            if n != val:
                errs.append(f"root_length: expected {val} got {n if n >= 0 else 'non-array body'}")
        elif key == "root_all_match":
            _all_match(actual if is_list else [], val, "root_all_match", errs, varstore)
        elif key == "root_contains":
            _contains(actual if is_list else [], val, "root_contains", errs, varstore)
        else:
            got = actual.get(key) if is_dict else None
            want = varstore.expand(val) if isinstance(val, str) else val
            if not jsonpath.cmp(got, "==", want):
                errs.append(f"{key}: expected {want!r} got {got!r}")
    return errs


def assert_expect(expect, status, body, raw, varstore):
    """Check an entire expect block. Returns a list of error strings."""
    errs = []
    if not isinstance(expect, dict):
        return errs
    raw = raw or ""

    if expect.get("status") is not None and status != expect["status"]:
        errs.append(f"status: expected {expect['status']} got {status}")

    bc = expect.get("body_contains")
    if bc is not None:
        for needle in ([bc] if isinstance(bc, str) else bc):
            n = varstore.expand(str(needle))
            if n not in raw:
                errs.append(f"body_contains: {n!r} not in response")

    bnc = expect.get("body_not_contains")
    if bnc is not None:
        for needle in ([bnc] if isinstance(bnc, str) else bnc):
            n = varstore.expand(str(needle))
            if n in raw:
                errs.append(f"body_not_contains: {n!r} unexpectedly present")

    jp = expect.get("json_path")
    if jp is not None:
        for expr in ([jp] if isinstance(jp, str) else jp):
            e = varstore.expand(expr)
            if body is None:
                errs.append(f"json_path: response is not JSON (expr {e!r})")
                continue
            ok, detail = jsonpath.evaluate_expr(e, body)
            if not ok:
                errs.append(f"json_path: {detail}")

    if expect.get("body") is not None:
        errs.extend(assert_body(expect["body"], body, varstore))

    return errs
