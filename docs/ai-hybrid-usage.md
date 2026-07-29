# AI Hybrid Usage Guide

Tài liệu này mô tả cách sử dụng các AI operation trong native-task-manager theo giao thức **agent-native** (mặc định) và cách bật **headless fallback** cho môi trường CI/cron.

---

## 1. Tổng quan — Hai đường thực thi AI

Sub 4/5 (ai-hybrid) áp dụng chiến lược hybrid cho tất cả AI operation (`parse-prd`, `expand`, `analyze-complexity`, `research`):

| Đường | Khi nào kích hoạt | Network call từ core |
|---|---|---|
| **agent-native** (mặc định) | Host agent có mặt (`CLAUDECODE=1` hoặc `SPEC_FLOW_HOST_AGENT=1`) | Không |
| **headless fallback** | Không có host + `taskCore.headlessFallback` được cấu hình | Có (HTTP LLM endpoint) |
| **ERR_AI_HOST_REQUIRED** | Không có host + fallback null/không cấu hình | Không (fail-loud) |

---

## 2. Agent-Native Mode — Giao thức 3 pha

### 2.1 Nguyên lý

Orchestrator (Claude Code agent) vốn đã là LLM. Thay vì để core gọi LLM provider riêng, core chỉ phát một `GenerationSpec` JSON ra stdout (Phase 1), orchestrator tự sinh task JSON (Phase 2), sau đó gọi `tasks-import` để core validate và ghi deterministic (Phase 3).

Kết quả: **zero network call từ core** trên đường mặc định.

### 2.2 Host detection

AIRouter phát hiện host agent theo thứ tự ưu tiên:

```
1. SPEC_FLOW_HOST_AGENT (override tường minh)
   "1"      → host present (agent-native active)
   "0" / "" / "false" → no host (fallback hoặc ERR)
2. CLAUDECODE (set tự động bởi Claude Code runtime)
   truthy   → host present
3. Default → no host
```

Khi chạy trong Claude Code session, `CLAUDECODE=1` luôn được set sẵn — skill/command **không phải set thủ công**.

### 2.3 GenerationSpec — Hợp đồng Phase 1

Phase 1 phát ra object JSON sau ra stdout:

```json
{
  "operation": "parse-prd",
  "tag": "feat-x",
  "inputContent": "<nội dung SD.md hoặc task details>",
  "taskSchema": {
    "type": "object",
    "required": ["id", "title", "description", "status", "priority", "dependencies", "subtasks", "updatedAt"],
    "properties": { "...": "..." }
  },
  "expectedOutput": {
    "type": "array",
    "description": "Array of Task objects parsed from the requirements document, each conforming to taskSchema."
  },
  "instructions": "Parse the provided inputContent...",
  "context": {
    "parentTaskId": "1",
    "existingSubtaskIds": ["1.1", "1.2"]
  }
}
```

Field `context` chỉ có mặt khi op cần (ví dụ `expand`).

### 2.4 Chạy từng AI operation trong agent-native mode

#### parse-prd — Sinh tasks từ SD/requirements

Phase 1 (core emit spec):

```bash
SPEC_FLOW_HOST_AGENT=1 node bin/task-master parse-prd --input SD.md --tag feat-x
# → stdout: GenerationSpec JSON
# → exit 0
```

Phase 2 (orchestrator sinh tasks):

Orchestrator (Claude Code) đọc GenerationSpec từ stdout, dùng LLM capability sinh `Task[]` JSON array theo `taskSchema`.

Phase 3 (core import):

```bash
echo '<Task[] JSON>' | node bin/task-master tasks-import --tag feat-x
# → stdout: {"imported":5}
# → exit 0
```

Hoặc qua module API trực tiếp:

```javascript
const { importTasks } = require('./lib/task-importer.cjs');
const result = importTasks('feat-x', taskArray);
// result: { imported: 5 }
```

#### expand — Sinh subtasks cho task cha

```bash
SPEC_FLOW_HOST_AGENT=1 node bin/task-master expand --id 3 --tag feat-x
# → stdout: GenerationSpec với operation="expand", context.parentTaskId="3", context.existingSubtaskIds=[...]
```

GenerationSpec cho expand sẽ có `context.existingSubtaskIds` để orchestrator tránh tạo ID trùng.

#### analyze-complexity — Phân tích độ phức tạp

```bash
SPEC_FLOW_HOST_AGENT=1 node bin/task-master analyze-complexity --tag feat-x
# → stdout: GenerationSpec với instructions hướng dẫn sinh complexity report
```

#### research — Nghiên cứu query

```bash
SPEC_FLOW_HOST_AGENT=1 node bin/task-master research "How to implement zero-knowledge proofs?" --tag feat-x
# → stdout: GenerationSpec với operation="research"
```

### 2.5 Dùng two-phase helper trong code

`lib/two-phase.cjs` encapsulate toàn bộ 3 pha trong một hàm async, cho phép test và production dùng chung code path:

```javascript
const { runAgentNativeOp } = require('./lib/two-phase.cjs');

const result = await runAgentNativeOp(
  'parse-prd',
  { tag: 'feat-x', input: '/path/to/sd.md' },
  {
    // Injected LLM capability (production: real orchestrator; tests: mock)
    generate: async (spec) => {
      // spec is the GenerationSpec from Phase 1
      // In production, orchestrator calls its own LLM here
      // In tests, return a fixed task array
      return [
        {
          id: '1',
          title: 'Implement feature A',
          description: 'Build the core feature A module.',
          status: 'pending',
          priority: 'high',
          dependencies: [],
          subtasks: [],
          updatedAt: new Date().toISOString(),
        },
      ];
    },
    // Optional: test isolation
    _paths: { tasksFile: '/tmp/test/.taskmaster/tasks/tasks.json' },
  }
);
// result: { imported: 1 }
```

---

## 3. Headless Fallback — Cho CI/Cron không có Host Agent

### 3.1 Khi nào dùng headless fallback

Headless fallback dành cho môi trường **không có Claude Code host agent** (CI pipeline, cron job, script standalone). Core sẽ tự gọi một HTTP LLM endpoint, nhận kết quả, rồi đi qua cùng validate path như agent-native.

**Mặc định: headless fallback TẮT.** Core không khởi tạo HTTP client khi fallback không được cấu hình.

### 3.2 Bật headless fallback

Thêm `taskCore.headlessFallback` vào `.spec-flow/config.json`:

```json
{
  "taskCore": {
    "aiMode": "agent-native",
    "headlessFallback": {
      "endpoint": "https://api.openai.com/v1/chat/completions",
      "model": "gpt-4o",
      "apiKey": "sk-..."
    }
  }
}
```

Các field bắt buộc:

| Field | Type | Mô tả |
|---|---|---|
| `endpoint` | `string` | URL của LLM chat completion endpoint (OpenAI-compatible) |
| `model` | `string` | Model identifier (e.g. `"gpt-4o"`, `"claude-3-5-sonnet"`) |
| `apiKey` | `string` | API key; được gửi qua `Authorization: Bearer <apiKey>` header |

### 3.3 Tắt headless fallback

Set `taskCore.headlessFallback = null` (hoặc xóa key):

```json
{
  "taskCore": {
    "aiMode": "agent-native",
    "headlessFallback": null
  }
}
```

Khi null, core không khởi tạo HTTP client và không phát sinh network call cho AI op (FR-010).

### 3.4 Routing logic đầy đủ

```
route(op, params, config) →
  aiMode = config.taskCore.aiMode ?? "agent-native"

  if aiMode unknown:
    throw ERR_AI_MODE_UNKNOWN

  if aiMode == "headless-fallback":
    → HeadlessFallbackProvider.execute(...)

  if aiMode == "agent-native":
    hostPresent = SPEC_FLOW_HOST_AGENT (override) ?? CLAUDECODE ?? false

    if hostPresent:
      → AgentNativeDriver.generateSpec() → emit to stdout
    elif headlessFallback configured:
      → HeadlessFallbackProvider.execute(...)
    else:
      throw ERR_AI_HOST_REQUIRED
```

---

## 4. importTasks — Lớp validate + ghi duy nhất

Mọi kết quả AI (agent-native hay headless fallback) phải qua `importTasks` trước khi ghi. Hàm này:

1. Validate từng task theo `TASK_SCHEMA` — nếu bất kỳ task nào invalid, **toàn batch bị reject** (ERR_AI_SCHEMA_INVALID), không ghi gì.
2. Normalize `status` về `"pending"` cho mọi task.
3. Ghi atomic vào `tasks.json[tag]` via StorageCore (temp-then-rename).

```javascript
const { importTasks } = require('./lib/task-importer.cjs');

try {
  const result = importTasks('feat-x', taskArray, undefined, _paths);
  // result: { imported: N }
} catch (err) {
  if (err.code === 'ERR_AI_SCHEMA_INVALID') {
    // Fix the generated JSON and retry
    console.error('Schema invalid:', err.message);
  }
}
```

Required fields per task (từ `TASK_SCHEMA`):

```
id          string     — non-empty, unique within tag
title       string     — non-empty
description string     — non-empty
status      string     — one of: pending, in-progress, done, blocked, deferred, cancelled, review
priority    string     — one of: high, medium, low
dependencies string[]  — array of task ids
subtasks    array      — array of subtask objects (may be empty)
updatedAt   string     — ISO-8601 timestamp
```

Optional fields (`details`, `testStrategy`) are preserved through import if present.

---

## 5. Error Codes

| Code | Trigger | Recovery |
|---|---|---|
| `ERR_AI_HOST_REQUIRED` | agent-native + no host + fallback null | Set `SPEC_FLOW_HOST_AGENT=1` hoặc cấu hình `taskCore.headlessFallback` |
| `ERR_AI_SCHEMA_INVALID` | Task trong batch vi phạm schema | Fix generated JSON; retry `tasks-import` |
| `ERR_AI_MODE_UNKNOWN` | `taskCore.aiMode` có giá trị không hợp lệ | Sửa `.spec-flow/config.json`: valid values là `agent-native` hoặc `headless-fallback` |
| `ERR_AI_FALLBACK_FAILED` | Headless fallback HTTP error hoặc parse error | Kiểm tra endpoint/apiKey; xem error message cho HTTP status |

---

## 6. Ví dụ cấu hình đầy đủ

### Agent-native (Claude Code session — mặc định, không cần cấu hình gì thêm)

```json
{
  "taskCore": {
    "engine": "native",
    "aiMode": "agent-native"
  }
}
```

`CLAUDECODE=1` được Claude Code runtime set tự động — không cần thêm gì.

### Headless fallback cho CI (GitHub Actions)

```yaml
# .github/workflows/tasks.yml
- name: Parse PRD
  env:
    SPEC_FLOW_API_KEY: ${{ secrets.OPENAI_API_KEY }}
  run: |
    # config.json đã có headlessFallback với apiKey từ env
    node bin/task-master parse-prd --input SD.md --tag feat-x
```

```json
{
  "taskCore": {
    "engine": "native",
    "aiMode": "agent-native",
    "headlessFallback": {
      "endpoint": "https://api.openai.com/v1/chat/completions",
      "model": "gpt-4o",
      "apiKey": "${SPEC_FLOW_API_KEY}"
    }
  }
}
```

Lưu ý: `apiKey` trong config nên được inject từ environment variable; không hardcode secret vào file.
