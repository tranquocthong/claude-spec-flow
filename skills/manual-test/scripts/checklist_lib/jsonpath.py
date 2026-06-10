"""JSONPath-lite — zero-dependency, enough for checklist assertions and captures.

Path syntax:
  $                  root
  $.a.b              nested keys
  $.a[0] / $[0]      array index (negative ok)
  $[*] / $.items[*]  all elements of an array
  $.items[*].name    project a field across an array

`json_path:` expression operators:
  ==  !=  >  <  >=  <=  contains  exists
RHS is parsed as JSON when possible ("str", 123, 1.5, true, false, null),
else taken as a bare string.

Wildcard semantics: an expression passes when EVERY matched value satisfies it
and at least one value matched ($[*].masked == true → all items masked).
"""
import json
import re

# A token is either an [index|*] or an (optionally dotted) key.
_TOKEN_RE = re.compile(r"\[(\*|-?\d+)\]|\.?([A-Za-z_][\w-]*)")


def _tokens(path):
    p = path.strip()
    if p.startswith("$"):
        p = p[1:]
    toks = []
    for m in _TOKEN_RE.finditer(p):
        idx, key = m.group(1), m.group(2)
        if idx is not None:
            toks.append(("*",) if idx == "*" else ("idx", int(idx)))
        elif key is not None:
            toks.append(("key", key))
    return toks


def resolve(path, data):
    """Return the list of values matched by `path` (empty list if none)."""
    current = [data]
    for tok in _tokens(path):
        nxt = []
        for node in current:
            if tok[0] == "key":
                if isinstance(node, dict) and tok[1] in node:
                    nxt.append(node[tok[1]])
            elif tok[0] == "idx":
                if isinstance(node, list) and -len(node) <= tok[1] < len(node):
                    nxt.append(node[tok[1]])
            elif tok[0] == "*":
                if isinstance(node, list):
                    nxt.extend(node)
        current = nxt
    return current


def _parse_literal(s):
    s = s.strip()
    try:
        return json.loads(s)
    except (ValueError, TypeError):
        return s.strip("\"'")


def _num(x):
    try:
        return float(x)
    except (ValueError, TypeError):
        return None


def cmp(a, op, b):
    """Compare two values; numeric when both look numeric, else native/string."""
    if op == "==":
        return a == b or (_num(a) is not None and _num(a) == _num(b))
    if op == "!=":
        return not cmp(a, "==", b)
    na, nb = _num(a), _num(b)
    if na is not None and nb is not None:
        a, b = na, nb
    try:
        if op == ">":
            return a > b
        if op == "<":
            return a < b
        if op == ">=":
            return a >= b
        if op == "<=":
            return a <= b
    except TypeError:
        return False
    return False


def evaluate_expr(expr, data):
    """Evaluate a `json_path:` assertion → (ok: bool, detail: str)."""
    expr = expr.strip()

    m = re.match(r"^(.*\S)\s+exists$", expr)
    if m:
        vals = resolve(m.group(1).strip(), data)
        return (any(v is not None for v in vals)), f"exists: matched {len(vals)} value(s)"

    m = re.match(r"^(.*\S)\s+contains\s+(.+)$", expr)
    if m:
        vals = resolve(m.group(1).strip(), data)
        rhs = _parse_literal(m.group(2))

        def has(v):
            if isinstance(v, str) and isinstance(rhs, str):
                return rhs in v
            if isinstance(v, list):
                return rhs in v
            return False

        return (bool(vals) and all(has(v) for v in vals)), f"contains {rhs!r}: got {vals!r}"

    for op in ("==", "!=", ">=", "<=", ">", "<"):
        idx = expr.find(op)
        if idx > 0:
            path = expr[:idx].strip()
            rhs = _parse_literal(expr[idx + len(op):])
            vals = resolve(path, data)
            if not vals:
                return False, f"{path}: no match"
            return (all(cmp(v, op, rhs) for v in vals)), f"{path} {op} {rhs!r}: got {vals!r}"

    return False, f"unparseable json_path expr: {expr!r}"
