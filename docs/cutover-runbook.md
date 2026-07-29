# Native Task Manager — Cutover Runbook

**Cập nhật 0.7.0 (2026-07-29):** Cutover đã được thực hiện chính thức — native là engine mặc định duy nhất, `task-master-ai@0.43.1` đã bị xóa khỏi `DEPENDENCIES.md`. C-6 (soak trên feature thực) bị bỏ qua có chủ đích — quyết định của maintainer, không phải theo quy trình khuyến nghị bên dưới. C-7 đã chạy. Rollback (§9.3, `scripts/rollback.cjs`) vẫn được giữ làm escape hatch dù chưa có dữ liệu soak thực tế.

Tài liệu này là runbook tổng hợp cho operator để thực hiện cutover từ `task-master-ai@0.43.1` sang native task engine trong spec-flow. Bao gồm các bước C-1 đến C-7, quy trình rollback §9.3, và các gate kiểm tra bắt buộc.

**Ngôn tắc:** Code, CLI, config và tên file luôn bằng tiếng Anh. Văn xuôi hướng dẫn có thể bằng tiếng Việt.

---

## Tổng quan — Strangler-fig strategy

Native task engine được xây dựng theo pattern strangler fig: engine mới chạy song song với legacy, được kiểm tra kỹ trước khi flip. Các bước được thiết kế để toàn bộ quá trình là **revertable** trong một `git revert` duy nhất.

```
C-1  Tiền điều kiện
C-2  Gate: equivalence-verify (bắt buộc pass trước khi flip)
C-3  Flip: chạy cutover script
C-4  Gate: /sf:doctor contract check
C-5  Smoke test thủ công
C-6  Monitoring soak (≥1 tính năng thực, allGreen)
C-7  DEFERRED: xóa legacy dependency (chỉ sau C-6 allGreen)
```

**Rollback §9.3** có thể chạy bất cứ lúc nào từ C-3 trở đi. Xem phần "Rollback" bên dưới.

---

## C-1 — Tiền điều kiện

Trước khi bắt đầu, kiểm tra các điều kiện sau:

1. **Branch hiện tại** là `feat/native-task-manager` (worktree riêng tại `spec-flow-ntm`).
2. **Test suite** phải xanh:

```bash
cd spec-flow-ntm
for f in test/*.test.cjs; do node "$f" || exit 1; done
```

3. **Git status** sạch — không có uncommitted changes.
4. Node >= 18 (`node --version`).
5. Không có active MCP session đang dùng `task-master-ai` — đóng tất cả client trước khi flip.

---

## C-2 — Gate: Equivalence Verify (bắt buộc pass)

Chạy equivalence verifier để xác nhận native engine cho output tương đương legacy engine trước khi flip bất cứ thứ gì:

```bash
node lib/equivalence-verify.cjs
```

**Output mong muốn:**

```
equivalent: true  diff: []
```

Nếu `equivalent: false`, verifier sẽ in diff ra stderr và exit 1. **Không được tiếp tục** cho đến khi pass.

**Programmatic API** (nếu cần kiểm tra trong script):

```javascript
const { verifyEquivalence } = require('./lib/equivalence-verify.cjs');
const result = await verifyEquivalence();
// result = { equivalent: true, diff: [] }
```

Gate này không cần network, không cần npx — chạy hoàn toàn in-process với native task-core.

---

## C-3 — Flip: Chạy Cutover Script

**Bước 1: dry-run trước** (không có `--confirm` = không write gì):

```bash
node scripts/cutover.cjs
```

Kiểm tra output xem planned changes có đúng không (config, .mcp.json, CLI files).

**Bước 2: áp dụng** (với `--confirm`):

```bash
node scripts/cutover.cjs --confirm
```

Script `scripts/cutover.cjs` thực hiện 3 thay đổi atomic:
- `.spec-flow/config.json` → set `taskCore.engine = 'native'`
- `.mcp.json` → thay thế legacy `task-master-ai` npx entry bằng native `node` entry
- CLI files (`commands/`, `skills/`) → rewrite legacy npx invocations sang `node bin/task-master`

**Commit ngay sau khi áp dụng** (3 thay đổi trong 1 commit để dễ `git revert`):

```bash
git add .spec-flow/config.json .mcp.json commands/ skills/
git commit -m "chore: cutover to native task engine (C-3)"
```

---

## C-4 — Gate: /sf:doctor Contract Check

Sau khi flip, chạy contract check để xác nhận native engine pass tất cả §9.4 categories:

```bash
node lib/doctor-contract.cjs
```

**Output mong muốn:** tất cả checks `pass`, exit 0.

```
[PASS] tool-registry: 5 tools registered
[PASS] cli-subcommands: 10 subcommands registered
[PASS] status-keys: 7 status keys present
[PASS] task-lifecycle: add/get/update/status round-trip ok
[PASS] stats-shape: byStatus/byPriority/total all present
ok: true
```

Nếu bất kỳ check nào `fail` → **thực hiện rollback ngay** (xem phần Rollback §9.3 bên dưới).

**Programmatic API:**

```javascript
const { runContractCheck } = require('./lib/doctor-contract.cjs');
const result = await runContractCheck();
// result = { ok: boolean, checks: [{ name, status, detail }] }
```

---

## C-5 — Smoke Test Thủ Công

Kiểm tra các thao tác cơ bản với native engine:

1. Restart MCP client (Claude Desktop / Zed / Claude Code) để pick up `.mcp.json` mới.
2. Thực hiện một MCP call: `get_tasks` với tag hiện tại — xác nhận response hợp lệ.
3. Thực hiện `next_task` — xác nhận trả về task đúng.
4. Chạy một CLI command: `node bin/task-master get-tasks` — xác nhận output.

Nếu có lỗi ở bước này → rollback (§9.3).

---

## C-6 — Monitoring Soak (≥1 tính năng thực)

Sử dụng ít nhất 1 feature đầy đủ với native engine, theo dõi health qua:

```bash
node lib/cutover-monitor.cjs <feature-name-1> [<feature-name-2> ...]
```

**Output mong muốn:**

```
allGreen: true — C-7 dependency removal gate OPEN
```

Nếu `allGreen: false` → không tiến hành C-7. Điều tra failures, roll back nếu cần.

**Programmatic API** (nếu tích hợp vào CI):

```javascript
const { monitorFeature, summarize } = require('./lib/cutover-monitor.cjs');

const results = await Promise.all([
  monitorFeature('feature-a'),
  monitorFeature('feature-b'),
]);
const summary = summarize(results);
// summary = { total, passed, failed, allGreen, failures }
if (!summary.allGreen) {
  process.exit(1);
}
```

`allGreen: true` là điều kiện cần thiết và đủ để mở gate C-7.

---

## C-7 — DEFERRED: Xóa Legacy Dependency

**Bước này chỉ được thực hiện SAU KHI C-6 allGreen.** Không chạy trước — `task-master-ai@0.43.1` là safety net rollback; xóa sớm là mất khả năng rollback.

**Bước 1: dry-run** (không write gì):

```bash
node scripts/remove-legacy-dep.cjs
```

**Bước 2: áp dụng** (với `--confirm`, sau khi engine đã native):

```bash
node scripts/remove-legacy-dep.cjs --confirm
```

Script `scripts/remove-legacy-dep.cjs` thực hiện:
1. **Safety guard (D5):** kiểm tra `readEngineConfig()` — từ chối nếu engine chưa phải `'native'`. Nếu engine chưa flip, script trả về `{ refused: true, reason: '...' }` và không write gì.
2. `DEPENDENCIES.md` → xóa dòng(s) pin `task-master-ai@0.43.1`.
3. `.mcp.json` → xóa legacy npx entry nếu còn tồn tại (post-cutover entry đã là native; bước này clean up leftover nếu có).

**Return summary:**

```javascript
{ depLinesRemoved: number, mcpCleaned: boolean }
// hoặc khi bị từ chối:
{ refused: true, reason: string }
```

**Programmatic API:**

```javascript
const { removeLegacyDep } = require('./scripts/remove-legacy-dep.cjs');
const result = await removeLegacyDep({
  dependenciesFile: 'DEPENDENCIES.md',  // default: repo root
  mcpFile: '.mcp.json',                 // default: repo root
  engineConfigFile: '.spec-flow/config.json', // default: repo root
  dryRun: false,
});
```

**Commit sau khi xóa:**

```bash
git add DEPENDENCIES.md .mcp.json
git commit -m "chore: remove task-master-ai@0.43.1 — cutover stable (C-7)"
```

**Note:** TC-011 (live E2E confirm post-removal) là operator gap — không có automated test nào cover bước này vì nó yêu cầu môi trường production thực. Operator xác nhận bằng cách chạy smoke test sau khi xóa.

---

## Rollback §9.3 — Khôi phục Legacy Bindings

Rollback có thể thực hiện bất cứ lúc nào từ sau C-3. Đây là inverse của cutover:

**Bước 1: dry-run** (không write gì):

```bash
node scripts/rollback.cjs
```

**Bước 2: áp dụng** (với `--confirm`):

```bash
node scripts/rollback.cjs --confirm
```

Script `scripts/rollback.cjs` khôi phục:
- `.spec-flow/config.json` → set `taskCore.engine = 'legacy'`
- `.mcp.json` → restore legacy npx `task-master-ai@0.43.1` entry
- CLI files → rewrite `node bin/task-master` back sang `npx -y -p task-master-ai@0.43.1 task-master`

**Spot-check data integrity sau rollback (TC-010):**

```javascript
const { verifyTasksIntact } = require('./scripts/rollback.cjs');
const { ok, tagCount, taskCount } = await verifyTasksIntact({
  tasksFile: '.taskmaster/tasks/tasks.json',
});
// ok: true, tagCount và taskCount phải khớp với pre-rollback
```

**Commit rollback:**

```bash
git add .spec-flow/config.json .mcp.json commands/ skills/
git commit -m "chore: rollback to legacy task engine (§9.3)"
```

Nếu muốn rollback toàn bộ C-3 commit trong một bước:

```bash
git revert HEAD  # revert commit "chore: cutover to native task engine (C-3)"
```

---

## Quy trình đầy đủ — Quick reference

| Bước | Lệnh | Pass condition | Rollback nếu fail |
|---|---|---|---|
| C-1 | `for f in test/*.test.cjs; do node "$f" \|\| exit 1; done` | 0 fail | Fix rồi retry |
| C-2 | `node lib/equivalence-verify.cjs` | `equivalent: true` | Fix native engine, retry |
| C-3 | `node scripts/cutover.cjs --confirm` | 3 files changed | N/A (write chưa xảy ra) |
| C-4 | `node lib/doctor-contract.cjs` | all checks pass | `node scripts/rollback.cjs --confirm` |
| C-5 | Manual MCP + CLI smoke test | Không có error | `node scripts/rollback.cjs --confirm` |
| C-6 | `node lib/cutover-monitor.cjs <features...>` | `allGreen: true` | `node scripts/rollback.cjs --confirm` |
| C-7 | `node scripts/remove-legacy-dep.cjs --confirm` | `depLinesRemoved >= 1` | N/A (chỉ xóa docs/config) |

**C-7 chỉ được chạy sau khi C-6 allGreen.** TC-011 là deferred operator gap — không có automated gate.
