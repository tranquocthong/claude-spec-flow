#!/usr/bin/env bash
# sd-drift-detect.sh — PreToolUse(Edit|Write) hook. SD-mismatch defense, layer 2.
# Checks whether a file being edited appears in trace.json task-file/fr-file links.
# When found: warns if the linked FR has no TC (real drift signal) OR if the linked
# task is in review/blocked status. Silent when the file is not in trace at all.
#
# Contract: fast, non-fatal. Always exit 0 (advisory). Reads tool event JSON from stdin.

# Resolve plugin root: prefer env var, fallback to script's own directory.
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
TRACE_FILE=".spec-flow/trace.json"

# --- Read stdin (the PreToolUse event JSON) ----------------------------------
input="$(cat 2>/dev/null || true)"

# --- No trace.json yet → nothing to check -----------------------------------
if [[ ! -f "$TRACE_FILE" ]]; then
  exit 0
fi

# --- Extract file_path from tool_input via inline node -e -------------------
# PreToolUse shape: { tool_name, tool_input: { file_path, ... } }
file_path="$(node -e "
try {
  var ev = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  var fp = (ev.tool_input && ev.tool_input.file_path) || '';
  process.stdout.write(fp);
} catch(e) {
  process.stdout.write('');
}
" <<< "$input" 2>/dev/null || true)"

if [[ -z "$file_path" ]]; then
  exit 0
fi

# --- Precise lookup in trace.json task-file / fr-file links -----------------
# Match by relative path, tolerant of leading ./ and cwd prefix.
# Warn ONLY when:
#   1. The linked FR has no TC (real drift signal — untested requirement being edited)
#   2. The linked task is in review or blocked status
# If the file is NOT in trace at all → stay silent (exit 0).

node -e "
var fs = require('fs');
var path = require('path');
var fp = process.argv[1] || '';
var cwd = process.cwd();

// Normalise file_path to a relative path with no leading ./
function normPath(p) {
  // Strip cwd prefix if absolute
  if (path.isAbsolute(p) && p.startsWith(cwd)) {
    p = p.slice(cwd.length);
  }
  // Strip leading /
  p = p.replace(/^\/+/, '');
  // Strip leading ./
  p = p.replace(/^\.\//, '');
  return p;
}

var normFp = normPath(fp);

var traceRaw;
try { traceRaw = fs.readFileSync('.spec-flow/trace.json', 'utf8'); } catch(e) { process.exit(0); }
var trace;
try { trace = JSON.parse(traceRaw); } catch(e) { process.exit(0); }

var links = trace.links || [];
var nodes = trace.nodes || {};
var frNodes = nodes.fr || [];
var taskNodes = nodes.tasks || [];

// Find all task-file and fr-file links that match this file
var matchedTaskIds = [];
var matchedFrIds = [];

links.forEach(function(lnk) {
  if (lnk.type !== 'task-file' && lnk.type !== 'fr-file') return;
  var linkFile = normPath(lnk.to || '');
  if (linkFile === normFp) {
    if (lnk.type === 'task-file') matchedTaskIds.push(String(lnk.from));
    if (lnk.type === 'fr-file')   matchedFrIds.push(String(lnk.from));
  }
});

// File not in trace at all → silent
if (matchedTaskIds.length === 0 && matchedFrIds.length === 0) {
  process.exit(0);
}

var warnings = [];

// For each matched FR: warn if it has no linked TC
matchedFrIds.forEach(function(frId) {
  var hasTc = links.some(function(l) { return l.type === 'fr-tc' && l.from === frId; });
  if (!hasTc) {
    var frNode = frNodes.find(function(n) { return n.id === frId; });
    var text = frNode ? frNode.text.slice(0, 60) : frId;
    warnings.push('FR ' + frId + ' (\"' + text + '\") has no linked test cases — edit may drift from untested spec');
  }
});

// For each matched task: warn if status is review or blocked
matchedTaskIds.forEach(function(taskId) {
  var taskNode = taskNodes.find(function(t) { return String(t.id) === taskId; });
  if (taskNode && (taskNode.status === 'review' || taskNode.status === 'blocked')) {
    warnings.push('task #' + taskId + ' \"' + (taskNode.title || '') + '\" [' + taskNode.status + '] — verify SD alignment before editing');
  }
});

if (warnings.length > 0) {
  var allIds = matchedFrIds.concat(matchedTaskIds).join(', ');
  process.stderr.write('spec-flow: sd-drift-detect: editing ' + fp + ' (linked: ' + allIds + ')\n');
  warnings.forEach(function(w) { process.stderr.write('  WARNING: ' + w + '\n'); });
  process.stderr.write('  Run: node bin/flow-tools.cjs trace-impact --ids \"' + allIds + '\"\n');
}
" "$file_path" 2>&1 || true

exit 0
