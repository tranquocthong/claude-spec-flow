"""Token resolution — returns (header_name, header_value) for a token def.

Three forms:
  auth: keycloak_ropc                 → kc-ropc.sh password grant → Bearer
  type: keycloak-client-credentials   → OAuth2 client_credentials grant
  payload: '<json>'                   → base64 → X-Userinfo (Summer/APISIX)

Token-def string fields are ${VAR}-expanded before use (e.g. ${USER_ID}).
"""
import base64
import os
import subprocess
import urllib.parse
import urllib.request


def resolve_token(tok_def, scripts_dir, varstore):
    td = varstore.expand_obj(tok_def)

    if td.get("auth") == "keycloak_ropc":
        cmd = [
            os.path.join(scripts_dir, "kc-ropc.sh"),
            td["realm"], td["client"], td["username"], td["password"],
        ]
        if td.get("client_secret"):
            cmd.append(td["client_secret"])
        try:
            out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL).decode().strip()
            return ("Authorization", f"Bearer {out}")
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"kc-ropc.sh failed: {e}") from e

    if td.get("type") == "keycloak-client-credentials":
        data = urllib.parse.urlencode({
            "grant_type": "client_credentials",
            "client_id": td["client_id"],
            "client_secret": td["client_secret"],
        }).encode()
        req = urllib.request.Request(
            td["token_url"], data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                import json
                jwt = json.loads(resp.read()).get("access_token", "")
            if not jwt:
                raise RuntimeError("no access_token in response")
            prefix = td.get("header_prefix", "Bearer ").rstrip()
            return (td.get("header", "Authorization"), f"{prefix} {jwt}")
        except Exception as e:
            raise RuntimeError(f"client_credentials grant failed: {e}") from e

    if "payload" in td:
        enc = base64.b64encode(td["payload"].encode()).decode().rstrip("\n")
        return ("X-Userinfo", enc)

    raise ValueError(f"unsupported token def: {tok_def}")
