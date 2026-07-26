# Agent-Native Two-Phase Protocol

Tài liệu này mô tả giao thức 3 pha (three-phase agent-native protocol) được triển khai trong `lib/two-phase.cjs` — một helper orchestrator-side có thể test độc lập, không cần subprocess thật hoặc LLM thật.

---

## 1. Tổng quan — Tại sao cần giao thức 3 pha?

Trong kiến trúc agent-native (SD §9.2), CLI không tự gọi LLM. Thay vào đó:

- **Phase 1**: CLI phát ra một `GenerationSpec` (plain JSON) ra stdout.
- **Phase 2**: Orchestrator LLM (ví dụ Claude Code agent) đọc spec và tự thực hiện AI operation, trả về `Task[]`.
- **Phase 3**: CLI nhận lại `Task[]` (qua stdin) và import atomically vào tasks.json.

Điều này đảm bảo zero-network từ phía native manager — không có HTTP call, không có API key trong code native.

Helper `runAgentNativeOp` encapsulate toàn bộ 3 pha trong một hàm async, với dependency injection để test và production dùng chung cùng một code path.

---

## 2. GenerationSpec — Hợp đồng Phase 1

Phase 1 phát ra một `GenerationSpec` JSON object với các field sau:

```json
{
  "operation": "parse-prd",
  "tag": "feat-x",
  "inputContent": "<nội dung file SD.md>",
  "taskSchema": { ... },
  "expectedOutput": {
    "type": "array",
    "description": "Array of Task objects..."
  },
  "instructions": "Parse the provided inputContent...",
  "context": { ... }
}
```

| Field | Mô tả |
|---|---|
| `operation` | Tên op: `parse-prd`, `expand`, `analyze-complexity`, `research` |
| `tag` | Tag namespace hiện tại |
| `inputContent` | Nội dung đầu vào: nội dung file SD (parse-prd), JSON task (expand), JSON tasks list (analyze-complexity), query string (research) |
| `taskSchema` | Mô tả JSON Schema của Task object — LLM dùng để validate output |
| `expectedOutput` | Mô tả output mong muốn (type + description) |
| `instructions` | Hướng dẫn cụ thể cho LLM theo từng operation |
| `context` | (optional) Context bổ sung, ví dụ cho `expand`: `{ parentTaskId, existingSubtaskIds }` |

---

## 3. Các operation được hỗ trợ — Mapping tham số

| Operation | Phase 1 CLI argv | Phase 1 input | Phase 2 output |
|---|---|---|---|
| `parse-prd` | `parse-prd --input <file> --tag <tag>` | Nội dung file SD/PRD | `Task[]` |
| `expand` | `expand --id <id> --tag <tag>` | JSON của parent task | `Task[]` (subtasks) |
| `analyze-complexity` | `analyze-complexity --tag <tag>` | JSON của tất cả tasks | Complexity entries |
| `research` | `research <query> --tag <tag>` | Query string | Research results |

---

## 4. Cách orchestrator sử dụng helper này

### 4.1 Production (Claude Code agent / spec-flow skill)

```javascript
const { runAgentNativeOp } = require('./lib/two-phase.cjs');

// Bước 1: Orchestrator (Claude Code) cung cấp generate() backed by LLM
async function generate(spec) {
  // spec.instructions + spec.inputContent + spec.taskSchema → LLM generates tasks
  const rawJson = await claudeCodeAgent.askLLM(spec.instructions, spec.inputContent);
  return JSON.parse(rawJson); // Task[]
}

// Bước 2: Gọi helper — 3 pha xảy ra in-process
const result = await runAgentNativeOp(
  'parse-prd',
  { tag: 'feat-my-feature', input: '/path/to/sd.md' },
  { generate }
);

console.log(result); // { imported: 7 }
```

### 4.2 Test isolation (unit test với mock generate)

```javascript
const { runAgentNativeOp } = require('../lib/two-phase.cjs');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
const _paths = {
  tasksFile: path.join(tmpDir, '.taskmaster/tasks/tasks.json'),
  configFile: path.join(tmpDir, '.spec-flow/config.json'),
};

// Viết config cho test isolation
fs.mkdirSync(path.dirname(_paths.configFile), { recursive: true });
fs.writeFileSync(_paths.configFile, JSON.stringify({
  taskCore: { engine: 'native', aiMode: 'agent-native' }
}));

// Mock generate — không cần LLM thật
const generate = async (spec) => [
  { id: '1', title: 'Task A', description: '...', status: 'pending',
    priority: 'medium', dependencies: [], subtasks: [],
    updatedAt: new Date().toISOString() }
];

const result = await runAgentNativeOp(
  'parse-prd',
  { tag: 'test-tag', input: '/path/to/test-sd.md' },
  { generate, _paths }
);
// result = { imported: 1 }
```

### 4.3 Headless fallback (không có host LLM)

Khi không có host agent, không dùng `runAgentNativeOp`. Thay vào đó, engine-router tự động fallback sang `headless-fallback-provider` nếu `taskCore.headlessFallback` được cấu hình trong `.spec-flow/config.json`. Xem `lib/headless-fallback-provider.cjs`.

---

## 5. Dependency injection — Signature đầy đủ

```javascript
runAgentNativeOp(op, params, deps)
```

| Arg | Type | Mô tả |
|---|---|---|
| `op` | `string` | Operation: `'parse-prd'` \| `'expand'` \| `'analyze-complexity'` \| `'research'` |
| `params` | `object` | `{ tag, input?, id?, query? }` — op-specific |
| `deps.generate` | `async function` | **REQUIRED.** `(GenerationSpec) → Task[]`. Đây là LLM capability của orchestrator. Helper không gọi LLM. |
| `deps.runCli` | `function` | Optional. Default: `require('./cli-dispatcher.cjs').runCli`. Override để test Phase 1/3 isolation. |
| `deps._paths` | `object` | Optional. `{ tasksFile?, stateFile?, configFile? }` — test isolation. `configFile` được forward làm `_configFile` cho engine-router và ai-hybrid. |

---

## 6. Error handling

| Error code | Xuất phát từ đâu | Ý nghĩa |
|---|---|---|
| `ERR_PHASE1_FAILED` | Phase 1 CLI exit ≠ 0 | CLI subcommand failed (ví dụ file not found, task not found) |
| `ERR_PHASE1_INVALID_SPEC` | Phase 1 stdout không phải JSON | AIRouter không emit spec (ví dụ config sai) |
| `ERR_AI_SCHEMA_INVALID` | Phase 3 TaskImporter | Generate trả về task thiếu required field — cả batch bị reject, tasks.json không thay đổi |
| `ERR_UNKNOWN_OP` | `_buildPhase1Argv` | Op không được hỗ trợ |

---

## 7. Ghi chú quan trọng — Cutover deferred

**NOTE:** Helper `runAgentNativeOp` và tài liệu này là phần chuẩn bị cho việc tích hợp vào spec-flow skill `/sf:phase`. Tuy nhiên, việc flip thực sự (làm spec-flow gọi native parse-prd thay vì `npx task-master-ai`) được **defer sang subtask 5/5 (cutover)**. Mục tiêu của sub 4/5 là:

1. Xây dựng helper có thể test độc lập (không wiring vào live code).
2. Cung cấp tài liệu hướng dẫn cách orchestrator sẽ sử dụng nó.
3. Đảm bảo không có file command/skill nào bị chỉnh sửa (`commands/`, `skills/`).

Các file hiện tại bị **tuyệt đối không chỉnh sửa** trong task này:
- `commands/phase.md`
- `commands/ingest.md`
- `skills/` (bất kỳ file nào)
- Bất kỳ file command/skill hiện có nào

Cutover sẽ được thực hiện trong sub 5/5 theo quy trình `/sf:change`.
