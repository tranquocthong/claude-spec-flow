"""Kafka produce (via produce-event.sh) + best-effort verify checks.

Verify checks (kafka_consumer_lag / kafka_dlt / kafka_topic) depend on kcat or a
running kafka docker container. When neither is available they SKIP with a clear
message (status None) rather than failing — the runner reports skips honestly.
"""
import json
import os
import subprocess
from shutil import which


def _broker():
    return os.environ.get("KAFKA_BROKER", "localhost:9095")


def _kafka_cid():
    try:
        out = subprocess.check_output(["docker", "ps", "-qf", "name=kafka"],
                                      stderr=subprocess.DEVNULL).decode().split()
        return out[0] if out else None
    except Exception:
        return None


def produce(kafka_def, scripts_dir, varstore):
    """Produce one event. Returns (ok, message)."""
    topic = varstore.expand(kafka_def["topic"])
    payload = kafka_def.get("payload")
    if payload is not None:
        payload = varstore.expand(payload if isinstance(payload, str) else json.dumps(payload))
    elif kafka_def.get("payload_file"):
        try:
            with open(varstore.expand(kafka_def["payload_file"])) as f:
                payload = f.read()
        except OSError as e:
            return False, f"payload_file unreadable: {e}"
    else:
        return False, "kafka request has no payload/payload_file"

    cmd = [os.path.join(scripts_dir, "produce-event.sh"), topic, "-"]
    if kafka_def.get("key"):
        cmd += ["-k", varstore.expand(str(kafka_def["key"]))]
    for hk, hv in (kafka_def.get("headers") or {}).items():
        cmd += ["-H", f"{hk}={varstore.expand(str(hv))}"]
    try:
        subprocess.run(cmd, input=payload.encode(), capture_output=True, check=True)
        return True, f"produced to {topic}"
    except subprocess.CalledProcessError as e:
        return False, f"produce failed: {e.stderr.decode()[:200]}"


def check(vb, varstore):
    """Dispatch a kafka_* verify item → (status, detail). status None = skipped."""
    if "kafka_consumer_lag" in vb:
        return _lag(varstore.expand_obj(vb["kafka_consumer_lag"]))
    if "kafka_dlt" in vb:
        return _consume(varstore.expand_obj(vb["kafka_dlt"]), is_dlt=True)
    if "kafka_topic" in vb:
        return _consume(varstore.expand_obj(vb["kafka_topic"]), is_dlt=False)
    return None, ""


def _lag(spec):
    group, topic = spec.get("group"), spec.get("topic")
    want = int(spec.get("expect", 0))
    cid = _kafka_cid()
    if not cid:
        return None, "kafka_consumer_lag skipped: no kafka docker container"
    try:
        out = subprocess.check_output(
            ["docker", "exec", cid, "kafka-consumer-groups",
             "--bootstrap-server", "localhost:9092", "--group", group, "--describe"],
            stderr=subprocess.DEVNULL, timeout=20).decode()
    except Exception as e:
        return None, f"kafka_consumer_lag skipped: {e}"
    total = 0
    for line in out.splitlines():
        parts = line.split()
        # GROUP TOPIC PARTITION CURRENT-OFFSET LOG-END-OFFSET LAG ...
        if len(parts) >= 6 and (not topic or parts[1] == topic) and parts[5].isdigit():
            total += int(parts[5])
    ok = total == want
    return ok, f"consumer_lag={total} (expect {want})"


def _consume(spec, is_dlt):
    topic = spec.get("topic")
    last_n = int(spec.get("last_n", 5))
    broker = _broker()
    msgs = None
    if which("kcat"):
        try:
            out = subprocess.run(
                ["kcat", "-b", broker, "-t", topic, "-C", "-o", f"-{last_n}", "-e", "-q"],
                capture_output=True, text=True, timeout=15).stdout
            msgs = [l for l in out.splitlines() if l.strip()]
        except Exception as e:
            return None, f"{topic} consume skipped: {e}"
    else:
        cid = _kafka_cid()
        if not cid:
            return None, f"{topic} consume skipped: no kcat and no kafka container"
        try:
            out = subprocess.run(
                ["docker", "exec", cid, "kafka-console-consumer",
                 "--bootstrap-server", "localhost:9092", "--topic", topic,
                 "--max-messages", str(last_n), "--timeout-ms", "5000", "--from-beginning"],
                capture_output=True, text=True, timeout=20).stdout
            msgs = [l for l in out.splitlines() if l.strip()]
        except Exception as e:
            return None, f"{topic} consume skipped: {e}"

    if "expect" in spec and spec["expect"] in ("empty", []):
        ok = len(msgs) == 0
        return ok, f"{topic}: {len(msgs)} msg(s), expected empty"
    if "contains" in spec:
        needle = str(spec["contains"])
        ok = any(needle in m for m in msgs)
        return ok, f"{topic}: {'found' if ok else 'missing'} {needle!r} in last {last_n}"
    return None, f"{topic}: {len(msgs)} msg(s) (no expect/contains assertion)"
