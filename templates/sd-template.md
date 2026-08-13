# Solution Design: [Tên Tính Năng / Feature Name]

{/* Hướng dẫn sử dụng: Xóa các chú thích trước khi publish tài liệu */}

{/*
  ⚠️ MDX / Docusaurus Compatibility Notes:
  - File này dùng JSX comments thay vì HTML comments để tương thích MDX/Docusaurus
  - KHÔNG dùng HTML comments trong .mdx files — sẽ gây build error trên Docusaurus
  - Trong mermaid code blocks thì vẫn dùng syntax bình thường (không bị ảnh hưởng bởi MDX parser)
  - Tránh dùng ký tự đặc biệt JSX ngoài code blocks: < > { } — nếu cần thì escape: {'<'} {'>'}  {'{'} {'}'}
  - Nếu cần dùng biểu thức chứa dấu < > ngoài code block (ví dụ: generic types), wrap trong backticks: `Map<String, Object>`
  - Checkbox syntax `- [ ]` và `- [x]` hoạt động bình thường trong Docusaurus MDX
*/}

---

## Document Information

| Field        | Value                            |
|--------------|----------------------------------|
| **Document ID**  | SD-[YYYY]-[NNN]              |
| **Version**      | 1.0.0                        |
| **Status**       | Draft / In Review / Approved |
| **Created**      | YYYY-MM-DD                   |
| **Last Updated** | YYYY-MM-DD                   |
| **Author(s)**    | [Tên] – [Team/Role]          |
| **Reviewer(s)**  | [Tên] – [Team/Role]          |
| **Approver(s)**  | [Tên] – [Team/Role]          |

### Revision History

| Version | Date       | Author | Changes                    |
|---------|------------|--------|----------------------------|
| 1.0.0   | YYYY-MM-DD | [Tên]  | Initial draft              |
| 1.1.0   | YYYY-MM-DD | [Tên]  | Updated after review       |

---

## Table of Contents

{/*
  Cấu trúc Part-based: nhóm sections theo concern.
  Tùy loại thiết kế, giữ / xóa Part phù hợp:
  - API Service → Giữ Part B (API Design), bỏ Part C (Internal Process Design)
  - Internal Process → Giữ Part C, bỏ Part B
  - Hybrid → Giữ cả Part B + Part C
*/}

**Part A — Context & Foundation**

1. [Overview](#1-overview)
2. [Background & Problem Statement](#2-background--problem-statement)
3. [Goals & Non-Goals](#3-goals--non-goals)
4. [Stakeholders](#4-stakeholders)
5. [Requirements](#5-requirements)
6. [Architecture Overview](#6-architecture-overview)
7. [Database Design](#7-database-design)
8. [Message Queue / Event Streaming](#8-message-queue--event-streaming)

**Part B — API Design**

9. [API Design](#9-api-design)
    - 9.1 [Overview & Authentication](#91-overview--authentication)
    - 9.2 [API Endpoints](#92-api-endpoints)
    - 9.3 [Common Error Responses](#93-common-error-responses)
    - 9.4 [Sequence Diagrams](#94-sequence-diagrams)

**Part C — Internal Process Design**

10. [Internal Process Design](#10-internal-process-design)
    - 10.1 [Process Overview](#101-process-overview)
    - 10.2 [Process Flow](#102-process-flow)
    - 10.3 [Processing Rules & Business Logic](#103-processing-rules--business-logic)
    - 10.4 [State Management](#104-state-management)
    - 10.5 [Scheduling & Execution Configuration](#105-scheduling--execution-configuration)
    - 10.6 [Input / Output Specification](#106-input--output-specification)
    - 10.7 [Observability & Monitoring](#107-observability--monitoring)
    - 10.8 [Sequence Diagrams](#108-sequence-diagrams)

**Part D — Cross-cutting Concerns**

11. [Security Considerations](#11-security-considerations)
12. [Error Handling & Resilience](#12-error-handling--resilience)
13. [Testing Strategy](#13-testing-strategy)
14. [Risks & Mitigations](#14-risks--mitigations)
15. [Open Questions](#15-open-questions)
16. [Appendix: Glossary](#appendix-glossary)

---

## 1. Overview

{/* Tóm tắt ngắn gọn (3-5 câu) về tính năng / thay đổi này. Trả lời câu hỏi: Đây là gì? Tại sao cần làm? Ai sẽ dùng? */}

**Loại thay đổi:** `New Feature` | `Enhancement` | `Change Request` | `Bug Fix` | `Technical Debt`

**Loại thiết kế:** `API Service` | `Internal Process` | `Hybrid`

{/*
  - API Service: Tính năng expose API cho client / service khác consume
  - Internal Process: Logic xử lý nội bộ (batch job, scheduler, data pipeline, rule engine, state machine, background worker, v.v.)
  - Hybrid: Kết hợp cả API lẫn internal processing

  Tùy loại thiết kế, giữ / xóa Part phù hợp:
  - API Service → Giữ Part B, bỏ Part C
  - Internal Process → Giữ Part C, bỏ Part B
  - Hybrid → Giữ cả Part B + Part C
*/}

**Phạm vi ảnh hưởng:** `Frontend` | `Backend` | `Database` | `Infrastructure` | `Third-party Integration`

**Epic / Ticket:** [JIRA-XXXX](https://jira.example.com/browse/XXXX)

> **Tóm tắt:** [Mô tả ngắn gọn tính năng hoặc thay đổi cần thiết kế]

---

## 2. Background & Problem Statement

### 2.1 Bối cảnh (Context)

{/* Mô tả tình trạng hiện tại (As-Is). Hệ thống đang hoạt động như thế nào? */}

[Mô tả hệ thống / quy trình hiện tại]

### 2.2 Vấn đề (Problem Statement)

{/* Vấn đề cụ thể cần giải quyết là gì? Pain point của user/business là gì? */}

[Mô tả vấn đề đang gặp phải]

### 2.3 Giải pháp đề xuất (Proposed Solution)

{/* Tóm tắt cấp cao giải pháp sẽ làm (To-Be). Chi tiết ở các section sau */}

[Mô tả giải pháp ở mức high-level]

---

## 3. Goals & Non-Goals

### 3.1 Goals (Trong phạm vi)

- [Mục tiêu 1 — cụ thể, đo lường được]
- [Mục tiêu 2]
- [Mục tiêu 3]

### 3.2 Non-Goals (Ngoài phạm vi)

{/* Quan trọng: Xác định rõ những gì KHÔNG làm trong phiên bản này */}

- [Không làm: ví dụ "Không hỗ trợ multi-tenant trong phase này"]
- [Không làm: ...]

### 3.3 Success Criteria

{/* Làm thế nào để biết giải pháp này thành công? */}

| Criterion               | Target         | Measurement Method  |
|-------------------------|----------------|---------------------|
| [Tiêu chí 1]            | [Giá trị]      | [Cách đo]           |
| [Tiêu chí 2]            | [Giá trị]      | [Cách đo]           |

---

## 4. Stakeholders

| Role                | Name / Team        | Responsibility                      |
|---------------------|--------------------|-------------------------------------|
| Product Owner       | [Tên]              | Phê duyệt yêu cầu, acceptance       |
| Tech Lead           | [Tên]              | Review kiến trúc, approve design    |
| Backend Developer   | [Tên / Team]       | Implement backend services          |
| Frontend Developer  | [Tên / Team]       | Implement UI                        |
| QA Engineer         | [Tên / Team]       | Test plan, UAT                      |
| DevOps / SRE        | [Tên / Team]       | Deployment, infrastructure          |
| Security            | [Tên / Team]       | Security review                     |

---

## 5. Requirements

### 5.1 Functional Requirements

> **Table cells:** escape a literal `|` inside a cell as `\|` (markdown only — it keeps the row's column count so `route` / `trace-build` read the right cells). The value it denotes is the plain `|` character (U+007C): write `|`, never `\|`, in code, config, or payloads.

| ID     | Requirement                                              | Priority        |
|--------|----------------------------------------------------------|-----------------|
| FR-001 | [Mô tả yêu cầu chức năng 1]                              | Must Have       |
| FR-002 | [Mô tả yêu cầu chức năng 2]                              | Should Have     |
| FR-003 | [Mô tả yêu cầu chức năng 3]                              | Nice to Have    |

> Priority: `Must Have` | `Should Have` | `Nice to Have` (MoSCoW)

### 5.2 Non-Functional Requirements

| ID      | Category        | Requirement                                              | Target              |
|---------|-----------------|----------------------------------------------------------|---------------------|
| NFR-001 | Performance     | API response time (P95)                                  | < 200ms             |
| NFR-002 | Availability    | Service uptime                                           | 99.9%               |
| NFR-003 | Scalability     | Throughput                                               | [X] req/s           |
| NFR-004 | Security        | [Authentication / Authorization requirement]             | [Standard]          |
| NFR-005 | Data Retention  | [Chính sách lưu trữ dữ liệu]                             | [X] ngày/tháng      |

---

## 6. Architecture Overview

### 6.1 High-Level Architecture

{/* Diagram tổng quan hệ thống — dùng Mermaid */}

```mermaid
graph TB
    Client([Client / Web UI])
    GW[API Gateway]
    SvcA[Service A]
    SvcB[Service B]
    DB[(Database)]
    MQ[[Message Queue]]
    Cache[(Cache / Redis)]

    Client --> GW
    GW --> SvcA
    GW --> SvcB
    SvcA --> DB
    SvcA --> MQ
    SvcB --> MQ
    SvcA --> Cache
```

### 6.2 Component Description

| Component     | Technology      | Responsibility                              |
|---------------|-----------------|---------------------------------------------|
| API Gateway   | [Kong / Nginx]  | Rate limiting, routing, auth                |
| Service A     | [NestJS / Go]   | [Mô tả trách nhiệm]                         |
| Service B     | [Spring Boot]   | [Mô tả trách nhiệm]                         |
| Database      | [PostgreSQL]    | [Mô tả dữ liệu lưu trữ]                    |
| Cache         | [Redis]         | [Session / computed data caching]           |
| Message Queue | [Kafka / RMQ]   | [Async event processing]                    |

### 6.3 Các Thay Đổi So Với Hiện Tại

{/* Mô tả delta — những gì THAY ĐỔI so với hệ thống hiện tại */}

- **Thêm mới:** [Component / service mới]
- **Thay đổi:** [Component / service có thay đổi]
- **Xóa bỏ:** [Component / service deprecated]

---

## 7. Database Design

{/* Nếu không có thay đổi database → XÓA toàn bộ section này */}

### 7.1 ERD Diagram

```mermaid
erDiagram
    TABLE_A {
        bigint id PK
        varchar name
        timestamp created_at
        timestamp updated_at
    }

    TABLE_B {
        bigint id PK
        bigint table_a_id FK
        varchar status
        jsonb metadata
        timestamp created_at
    }

    TABLE_A ||--o{ TABLE_B : "has many"
```

### 7.2 Table Definitions

#### `table_name` (New / Modified)

| Column        | Type          | Nullable | Default | Description                    |
|---------------|---------------|----------|---------|--------------------------------|
| `id`          | `BIGINT`      | NO       | auto    | Primary key                    |
| `column_name` | `VARCHAR(255)`| NO       | —       | [Mô tả cột]                    |
| `status`      | `VARCHAR(50)` | NO       | —       | Enum: `active`, `inactive`     |
| `metadata`    | `JSONB`       | YES      | `{}`    | [Mô tả dữ liệu JSON]           |
| `created_at`  | `TIMESTAMP`   | NO       | NOW()   | Thời điểm tạo record           |
| `updated_at`  | `TIMESTAMP`   | NO       | NOW()   | Thời điểm cập nhật cuối        |

### 7.3 Index Design

{/* Tách riêng index design per table — dễ review và không bị lẫn với table definition */}

#### `table_name`

| Index Name                  | Columns                     | Type        | Purpose                                 |
|-----------------------------|-----------------------------|-------------|-----------------------------------------|
| `table_name_pkey`           | `id`                        | PRIMARY KEY | PK                                      |
| `table_name_status_idx`     | `status`                    | B-TREE      | Filter by status                        |
| `table_name_composite_idx`  | `(tenant_id, created_at)`   | B-TREE      | [Mô tả mục đích composite index]        |

### 7.4 Data Migration Plan

{/* Nếu có thay đổi schema cần migrate data. Chỉ mô tả bằng text, KHÔNG viết SQL migration script */}

| Migration | Mô tả                              | Seed Data                          |
|-----------|-------------------------------------|------------------------------------|
| **V[N]**  | [Tạo table / Alter column / ...]    | [Mô tả seed data nếu có]           |
| **V[N+1]**| [Migration tiếp theo]               | [Không có seed data]               |

{/* Nếu có seed data quan trọng, mô tả chi tiết trong bảng riêng: */}

**Seed data `table_name` (nếu có):**

| # | Column A   | Column B       | Column C    | Ghi chú        |
|---|------------|----------------|-------------|----------------|
| 1 | [Giá trị]  | [Giá trị]      | [Giá trị]   | [Ghi chú]      |
| 2 | [Giá trị]  | [Giá trị]      | [Giá trị]   | [Ghi chú]      |

**Migration strategy:** `Online Migration` | `Offline Migration` | `Blue-Green`

**Estimated downtime:** [X phút / Zero downtime]

**Rollback plan:** [Mô tả cách rollback nếu migration thất bại]

---

## 8. Message Queue / Event Streaming

{/* Nếu không dùng message queue → XÓA toàn bộ section này */}

### 8.1 Overview

**Technology:** `Apache Kafka` | `RabbitMQ` | `AWS SQS/SNS` | `Redis Streams`

```mermaid
flowchart LR
    Producer[Service A\nProducer]
    Topic1[[topic.event.created]]
    Topic2[[topic.event.processed]]
    Consumer1[Service B\nConsumer]
    Consumer2[Service C\nConsumer]

    Producer -->|publish| Topic1
    Topic1 -->|subscribe| Consumer1
    Consumer1 -->|publish| Topic2
    Topic2 -->|subscribe| Consumer2
```

### 8.2 Topics / Queues

| Topic / Queue Name     | Producer    | Consumer(s)         | Retention | Partitions | Description              |
|------------------------|-------------|---------------------|-----------|------------|--------------------------|
| `topic.event.created`  | Service A   | Service B, C        | 7 ngày    | 6          | [Mô tả sự kiện]          |
| `topic.event.processed`| Service B   | Service C           | 3 ngày    | 3          | [Mô tả sự kiện]          |

### 8.3 Message Schema

**Topic: `topic.event.created`**

```json
{
  "eventId": "uuid-v4",
  "eventType": "event.created",
  "version": "1.0",
  "timestamp": "2024-01-01T00:00:00Z",
  "source": "service-a",
  "payload": {
    "id": 123,
    "field1": "value1",
    "field2": "value2"
  }
}
```

### 8.4 Consumer Configuration

| Consumer Group          | Topic                  | Processing Mode  | Retry Policy              |
|-------------------------|------------------------|------------------|---------------------------|
| `service-b-consumer`    | `topic.event.created`  | At-least-once    | 3 retries, exponential    |
| `service-c-consumer`    | `topic.event.processed`| Exactly-once     | DLQ after 3 failures      |

---

## 9. API Design

{/* Nếu loại thiết kế là "Internal Process" → XÓA toàn bộ Part B (section này) */}

### 9.1 Overview & Authentication

- **Base URL:** `https://api.example.com`
- **Version:** `v1`
- **Authentication:** `Bearer Token (JWT)` | `API Key` | `OAuth 2.0`

{/* Nếu có nhiều nhóm API (public + backoffice), mô tả tổng quan ở đây */}

| API Group    | Base Path             | Auth                | Role              |
|--------------|-----------------------|---------------------|-------------------|
| Public API   | `/api/v1/...`         | JWT (end-user)      | `user`            |
| Backoffice   | `/bo/api/v1/...`      | JWT (admin)         | `admin`, `viewer` |

### 9.2 API Endpoints

{/* Mô tả chi tiết từng API endpoint mới hoặc thay đổi */}

---

#### `POST /api/v1/{resource}`

**Mô tả:** [Mô tả chức năng của API này]

**Authorization:** `Required` — Role: `[user / admin / service]`

**Headers:**

| Header          | Required | Value                        |
|-----------------|----------|------------------------------|
| `Authorization` | Yes      | `Bearer {access_token}`      |
| `Content-Type`  | Yes      | `application/json`           |
| `X-Request-ID`  | No       | UUID để trace request        |

**Request Body:**

```json
{
  "field1": "string",
  "field2": 123,
  "field3": {
    "nestedField": "value"
  }
}
```

| Field       | Type     | Required | Validation             | Description         |
|-------------|----------|----------|------------------------|---------------------|
| `field1`    | `string` | Yes      | maxLength: 255         | [Mô tả]             |
| `field2`    | `integer`| Yes      | min: 1, max: 9999      | [Mô tả]             |
| `field3`    | `object` | No       | —                      | [Mô tả]             |

**Response — 201 Created:**

```json
{
  "success": true,
  "data": {
    "id": 456,
    "field1": "string",
    "createdAt": "2024-01-01T00:00:00Z"
  },
  "message": "Resource created successfully"
}
```

---

#### `GET /api/v1/{resource}/{id}`

**Mô tả:** [Mô tả chức năng]

**Authorization:** `Required` — Role: `[user / admin]`

**Path Parameters:**

| Parameter | Type     | Required | Description       |
|-----------|----------|----------|-------------------|
| `id`      | `integer`| Yes      | ID của resource   |

**Query Parameters:**

| Parameter  | Type      | Required | Default | Description              |
|------------|-----------|----------|---------|--------------------------|
| `include`  | `string`  | No       | —       | Comma-separated relations|
| `fields`   | `string`  | No       | —       | Sparse fieldsets         |

**Response — 200 OK:**

```json
{
  "success": true,
  "data": {
    "id": 456,
    "field1": "string",
    "field2": 123,
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  }
}
```

---

#### `GET /api/v1/{resource}`

**Mô tả:** Lấy danh sách resource với pagination

**Query Parameters:**

| Parameter  | Type      | Required | Default | Description              |
|------------|-----------|----------|---------|--------------------------|
| `page`     | `integer` | No       | 1       | Số trang                 |
| `limit`    | `integer` | No       | 20      | Số item / trang (max 100)|
| `sort`     | `string`  | No       | `-createdAt` | Field sort, prefix `-` = DESC |
| `filter`   | `string`  | No       | —       | Filter expression        |
| `search`   | `string`  | No       | —       | Tìm kiếm full-text       |

**Response — 200 OK:**

```json
{
  "success": true,
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  }
}
```

---

#### `PUT /api/v1/{resource}/{id}`

**Mô tả:** Cập nhật resource (full update)

{/* Tương tự POST, mô tả request body và responses */}

---

#### `DELETE /api/v1/{resource}/{id}`

**Mô tả:** Xóa resource (soft delete)

**Response — 204 No Content** (không có body)

**Lưu ý:** Sử dụng soft delete — set `deleted_at = NOW()`, không xóa khỏi database.

### 9.3 Common Error Responses

| HTTP Status | Error Code              | Description                         |
|-------------|-------------------------|-------------------------------------|
| `400`       | `VALIDATION_ERROR`      | Request body không hợp lệ           |
| `401`       | `UNAUTHORIZED`          | Token không hợp lệ hoặc hết hạn     |
| `403`       | `FORBIDDEN`             | Không có quyền thực hiện            |
| `404`       | `NOT_FOUND`             | Resource không tồn tại              |
| `409`       | `RESOURCE_CONFLICT`     | Resource đã tồn tại / version conflict |
| `500`       | `INTERNAL_SERVER_ERROR` | Lỗi server                          |

**Error Response Format:**

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body",
    "details": [
      { "field": "field1", "message": "field1 is required" }
    ]
  },
  "requestId": "uuid-v4"
}
```

### 9.4 Sequence Diagrams

{/* Sequence diagrams nằm cùng section API Design để flow liền mạch: endpoint → logic → response */}

#### 9.4.1 [Flow 1: Tên Luồng Chính]

{/* Ví dụ: User tạo đơn hàng */}

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant WebUI
    participant APIGateway as API Gateway
    participant ServiceA as Service A
    participant ServiceB as Service B
    participant DB as Database
    participant MQ as Message Queue

    User->>WebUI: [Hành động người dùng]
    WebUI->>APIGateway: POST /api/v1/resource
    APIGateway->>APIGateway: Authenticate & Rate Limit
    APIGateway->>ServiceA: Forward request

    ServiceA->>DB: Query / Insert
    DB-->>ServiceA: Result

    ServiceA->>MQ: Publish event.created
    ServiceA-->>APIGateway: 201 Created
    APIGateway-->>WebUI: Response
    WebUI-->>User: Success notification

    MQ-->>ServiceB: Consume event.created
    ServiceB->>DB: Update related data
```

#### 9.4.2 [Flow 2: Tên Luồng Thứ Hai]

{/* Ví dụ: Async processing, error flow, v.v. */}

```mermaid
sequenceDiagram
    autonumber
    participant ServiceA as Service A
    participant MQ as Message Queue
    participant ServiceB as Service B
    participant DB as Database

    Note over ServiceA,MQ: Async Flow
    ServiceA->>MQ: Publish message
    MQ-->>ServiceB: Deliver message

    alt Success
        ServiceB->>DB: Process & Save
        ServiceB-->>MQ: ACK
    else Failure
        ServiceB-->>MQ: NACK
        MQ->>MQ: Retry (max 3 times)
        MQ->>MQ: Move to DLQ
    end
```

---

## 10. Internal Process Design

{/* Nếu loại thiết kế là "API Service" → XÓA toàn bộ Part C (section này) */}
{/* Mô tả chi tiết logic xử lý nội bộ: batch job, scheduler, data pipeline, rule engine, state machine, background worker, v.v. */}

### 10.1 Process Overview

**Loại process:** `Scheduled Job` | `Event-Driven Worker` | `Data Pipeline` | `Rule Engine` | `State Machine` | `Background Task` | `Other`

**Trigger:** `Cron Schedule` | `Event / Message` | `Manual` | `System Event` | `Condition-Based`

**Execution Mode:** `Synchronous` | `Asynchronous` | `Streaming`

> **Tóm tắt:** [Mô tả ngắn gọn process này làm gì, input → processing → output]

### 10.2 Process Flow

{/* Mô tả luồng xử lý chính bằng flowchart hoặc ASCII pipeline diagram */}

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PROCESSING PIPELINE                          │
│                                                                     │
│  ┌──────────┐   ┌──────────────┐   ┌────────────┐   ┌───────────┐ │
│  │ 1. LOAD  │──►│ 2. VALIDATE  │──►│ 3. PROCESS │──►│ 4. OUTPUT │ │
│  │ INPUT    │   │ & ENRICH     │   │ & APPLY    │   │ & NOTIFY  │ │
│  └──────────┘   └──────────────┘   └────────────┘   └───────────┘ │
│       │               │                  │                │        │
│  [Data source]   [Validation rules] [Business logic] [Persist +   │
│                                                       notify]     │
└─────────────────────────────────────────────────────────────────────┘
```

{/* Hoặc dùng mermaid flowchart cho luồng chi tiết hơn: */}

```mermaid
flowchart TD
    Start([Trigger / Start])
    Step1[Bước 1: Lấy dữ liệu đầu vào]
    Step2[Bước 2: Validate / Enrich data]
    Step3{Điều kiện phân nhánh?}
    Step4A[Nhánh A: Xử lý case A]
    Step4B[Nhánh B: Xử lý case B]
    Step5[Bước 5: Lưu kết quả]
    End([Kết thúc])

    Start --> Step1
    Step1 --> Step2
    Step2 --> Step3
    Step3 -->|Điều kiện A| Step4A
    Step3 -->|Điều kiện B| Step4B
    Step4A --> Step5
    Step4B --> Step5
    Step5 --> End
```

### 10.3 Processing Rules & Business Logic

{/* Mô tả chi tiết các rules / logic xử lý. Nếu logic phức tạp, dùng pseudocode + decision table */}

| Rule ID | Tên Rule               | Điều kiện (Condition)                      | Hành động (Action)                         | Ưu tiên |
|---------|------------------------|--------------------------------------------|--------------------------------------------|---------|
| RL-001  | [Tên rule 1]           | [Điều kiện kích hoạt]                       | [Hành động thực hiện]                       | 1       |
| RL-002  | [Tên rule 2]           | [Điều kiện kích hoạt]                       | [Hành động thực hiện]                       | 2       |
| RL-003  | [Tên rule 3]           | [Điều kiện kích hoạt]                       | [Hành động thực hiện]                       | 3       |

**Decision Table (nếu cần):**

| Condition A | Condition B | Condition C | Action          |
|-------------|-------------|-------------|-----------------|
| True        | True        | *           | [Hành động 1]   |
| True        | False       | True        | [Hành động 2]   |
| False       | *           | *           | [Hành động 3]   |

**Pseudocode (nếu cần):**

```
for item in input:
    if condition_A(item):
        action_A(item)
    else if condition_B(item):
        action_B(item)
    else:
        skip(item)
```

### 10.4 State Management

{/* Nếu process có quản lý state / trạng thái → Mô tả state machine. Nếu không → Xóa sub-section này */}

```mermaid
stateDiagram-v2
    [*] --> Pending
    Pending --> Processing : trigger received
    Processing --> Completed : success
    Processing --> Failed : error
    Failed --> Processing : retry
    Failed --> Cancelled : max retries exceeded
    Completed --> [*]
    Cancelled --> [*]
```

| State        | Meaning                          | Allowed Transitions           | Entry Action                      |
|--------------|----------------------------------|-------------------------------|-----------------------------------|
| `Pending`    | Chờ xử lý                       | → Processing                  | —                                 |
| `Processing` | Đang xử lý                      | → Completed, → Failed         | Lock resource, start processing   |
| `Completed`  | Hoàn thành                       | —                             | Release resource, emit event      |
| `Failed`     | Lỗi                             | → Processing, → Cancelled     | Log error, notify                 |
| `Cancelled`  | Hủy                             | —                             | Cleanup, alert on-call            |

### 10.5 Scheduling & Execution Configuration

{/* Nếu process là scheduled/recurring → Điền bảng này. Nếu không → Xóa sub-section này */}

| Parameter               | Value                    | Mô tả                                             |
|-------------------------|--------------------------|----------------------------------------------------|
| **Schedule**            | `cron: 0 2 * * *`       | [Ví dụ: Chạy lúc 2:00 AM hàng ngày]               |
| **Timeout**             | [X phút / giờ]           | Thời gian tối đa cho mỗi lần chạy                  |
| **Concurrency**         | [1 / N instances]        | Cho phép chạy đồng thời bao nhiêu instance          |
| **Batch Size**          | [N records / batch]      | Số lượng records xử lý mỗi batch                    |
| **Idempotency**         | Yes / No                 | Process có idempotent không? Chạy lại có an toàn?    |
| **Distributed Lock**    | [Có / Không]             | Cơ chế lock khi chạy multi-instance                 |
| **Dead Letter Handling**| [Strategy]               | Xử lý message / record lỗi sau max retries          |

### 10.6 Input / Output Specification

**Input:**

| Source                 | Loại                    | Mô tả                                      | Volume ước tính         |
|------------------------|-------------------------|---------------------------------------------|-------------------------|
| [Database / Table X]   | Query result            | [Mô tả dữ liệu đầu vào]                    | [X records / lần chạy]  |
| [Message Queue / Topic]| Event message           | [Mô tả event trigger]                       | [X msg / phút]          |
| [External System / API]| API response            | [Mô tả dữ liệu từ hệ thống ngoài]          | [X requests / lần chạy] |

**Output:**

| Destination            | Loại                    | Mô tả                                      | Side Effects            |
|------------------------|-------------------------|---------------------------------------------|-------------------------|
| [Database / Table Y]   | Insert / Update         | [Mô tả dữ liệu output]                     | [Mô tả ảnh hưởng]       |
| [Message Queue / Topic]| Published event         | [Mô tả event phát ra]                       | [Downstream consumers]  |
| [Notification / Alert] | Email / Slack / Webhook | [Mô tả thông báo gửi đi]                    | —                       |

### 10.7 Observability & Monitoring

{/* Mô tả cách monitor process: metrics, alerts, dashboard */}

| Metric / Alert              | Điều kiện                             | Action                          |
|-----------------------------|---------------------------------------|---------------------------------|
| Process execution time      | > [X] phút                            | Warning alert                   |
| Failure rate                | > [X]% trong [Y] phút                 | Critical alert, page on-call    |
| Records processed           | Giảm > [X]% so với trung bình         | Warning alert                   |
| Queue lag / backlog          | > [X] messages pending                | Scale up consumers              |

### 10.8 Sequence Diagrams

{/* Sequence diagrams nằm cùng section Internal Process để flow liền mạch: trigger → processing → output */}

#### 10.8.1 [Flow 1: Main Processing Flow]

```mermaid
sequenceDiagram
    autonumber
    participant Scheduler as Scheduler / Trigger
    participant Worker as Worker / Processor
    participant DB as Database
    participant ExtSys as External System
    participant Notify as Notification

    Scheduler->>Worker: Trigger execution
    Worker->>DB: Fetch pending records (batch)

    loop For each record in batch
        Worker->>Worker: Apply business rules
        alt Rule matched → Action A
            Worker->>DB: Update record status
            Worker->>ExtSys: Call external system (if needed)
            ExtSys-->>Worker: Response
        else Rule not matched → Skip
            Worker->>DB: Mark as skipped
        end
    end

    Worker->>DB: Save processing results
    Worker->>Notify: Send summary report / alert

    Note over Worker: Log execution metrics (duration, processed count, error count)
```

#### 10.8.2 [Flow 2: Error / Rollback Flow]

{/* Mô tả luồng xử lý khi có lỗi, rollback, retry, v.v. */}

```mermaid
sequenceDiagram
    autonumber
    participant Worker as Worker / Processor
    participant DB as Database
    participant DLQ as Dead Letter Queue

    Worker->>DB: Process record
    DB-->>Worker: Error (timeout / constraint violation)

    alt Retryable error
        Worker->>Worker: Retry with backoff (attempt 1..N)
        alt Retry success
            Worker->>DB: Save result
        else Max retries exceeded
            Worker->>DLQ: Move to DLQ
            Worker->>Worker: Log error + continue batch
        end
    else Fatal error
        Worker->>Worker: Abort execution
        Worker->>Worker: Alert on-call
    end
```

---

## 11. Security Considerations

{/* Section này áp dụng cho MỌI loại thiết kế (API Service, Internal Process, Hybrid) */}

### 11.1 Authentication & Authorization

- **Cơ chế xác thực:** [JWT / OAuth 2.0 / API Key]
- **Token expiry:** Access token [15 phút], Refresh token [7 ngày]
- **RBAC:** Mô tả các role và permission liên quan

| Role     | Permission                              |
|----------|-----------------------------------------|
| `admin`  | Full CRUD                               |
| `user`   | Read + Create own resources             |
| `viewer` | Read only                               |

### 11.2 Input Validation & Sanitization

- [ ] Validate tất cả input từ client (type, length, format)
- [ ] Sanitize input để ngăn XSS
- [ ] Parameterized queries để ngăn SQL Injection
- [ ] Rate limiting tại API Gateway

### 11.3 Data Security

- [ ] Dữ liệu nhạy cảm được mã hóa at-rest (AES-256)
- [ ] Dữ liệu truyền tải qua HTTPS/TLS 1.3
- [ ] PII được mask trong logs
- [ ] Không log sensitive data (password, token, card number)

### 11.4 Audit Logging

{/* Các action nào cần ghi audit log? */}

| Action              | Actor  | Log Level | Retention  |
|---------------------|--------|-----------|------------|
| Create resource     | User   | INFO      | 90 ngày    |
| Delete resource     | Admin  | WARN      | 1 năm      |
| Auth failure        | System | WARN      | 30 ngày    |

---

## 12. Error Handling & Resilience

### 12.1 Error Classification

{/*
  Chọn bảng phù hợp với loại thiết kế. Hybrid giữ cả hai.
  Nếu có error codes riêng cho domain, thêm sub-section "Domain Error Codes" với bảng chi tiết.
*/}

**Cho API Service:**

| Category        | Example                          | Strategy                        |
|-----------------|----------------------------------|---------------------------------|
| Client Error    | Invalid input, Not found         | Return 4xx, không retry         |
| Transient Error | Timeout, DB connection           | Retry với exponential backoff   |
| Business Error  | Insufficient balance             | Return 422 + business error code|
| System Error    | Unhandled exception              | Return 500, alert on-call       |

**Cho Internal Process:**

| Category            | Example                               | Strategy                                          |
|---------------------|---------------------------------------|---------------------------------------------------|
| Data Validation     | Record thiếu field bắt buộc           | Skip record, log warning, tiếp tục batch          |
| Transient Error     | DB timeout, external API unavailable  | Retry record với backoff, mark failed sau max retry|
| Business Rule Error | Record vi phạm business rule          | Mark as rejected, log reason, notify nếu cần      |
| Partial Failure     | Một số records trong batch bị lỗi     | Commit thành công, retry/DLQ records lỗi          |
| Fatal Error         | Config sai, dependency không khởi tạo | Abort toàn bộ execution, alert on-call ngay       |

### 12.2 Domain Error Codes

{/* Nếu có error codes riêng cho domain (business errors), liệt kê chi tiết ở đây. Nếu không → Xóa sub-section này */}

| Error Code              | Trigger              | HTTP | Description                         |
|-------------------------|----------------------|------|-------------------------------------|
| `[DOMAIN_ERROR_001]`    | [Rule / Condition]   | 422  | [Mô tả lỗi cụ thể]                 |
| `[DOMAIN_ERROR_002]`    | [Rule / Condition]   | 422  | [Mô tả lỗi cụ thể]                 |

**Error Response Example:**

```json
{
  "success": false,
  "error": {
    "code": "DOMAIN_ERROR_001",
    "message": "[Mô tả lỗi cho end-user]",
    "details": {
      "violatedRule": "[rule name]",
      "currentValue": 123,
      "limitValue": 100
    }
  }
}
```

### 12.3 Retry Policy

| Operation              | Max Retries | Backoff Strategy         | DLQ             |
|------------------------|-------------|--------------------------|-----------------|
| DB write               | 3           | Exponential (1s, 2s, 4s) | No              |
| External API call      | 3           | Exponential + jitter     | No              |
| Message queue consumer | 5           | Exponential (5s, 15s...) | Yes, after 5x   |

### 12.4 Circuit Breaker

{/* Áp dụng Circuit Breaker cho các external dependency. Nếu không có → Xóa sub-section này */}

| Dependency      | Threshold  | Timeout   | Half-Open Probe    |
|-----------------|------------|-----------|--------------------|
| Service B       | 50% / 10s  | 5s        | 1 req / 30s        |
| External API    | 30% / 5s   | 3s        | 1 req / 60s        |

### 12.5 Fallback Strategy

- [Dependency A] — Fallback: [Mô tả behavior khi dependency down]
- [Dependency B] — Fallback: [Mô tả behavior]

---

## 13. Testing Strategy

### 13.1 Test Coverage Requirements

| Layer              | Type             | Coverage Target | Tool               |
|--------------------|------------------|-----------------|--------------------|
| Unit Tests         | Business logic   | ≥ 80%           | Jest / JUnit       |
| Integration Tests  | API endpoints    | Critical paths  | Supertest / RestAssured |
| E2E Tests          | Critical flows   | Happy paths     | Playwright / Cypress|
| Load Tests         | Performance      | NFR targets     | k6 / JMeter        |
| Security Tests     | OWASP Top 10     | —               | OWASP ZAP          |

### 13.2 Test Cases (Critical)

{/* Liệt kê test cases quan trọng. Nhóm theo flow / concern. */}

| ID     | Flow                        | Test Case                               | Expected Result               |
|--------|-----------------------------|-----------------------------------------|-------------------------------|
| TC-001 | [Flow chính]                | Happy path — valid input                | [Expected]                    |
| TC-002 | [Flow chính]                | Validation error                        | [Expected]                    |
| TC-003 | [Business rule]             | [Rule X triggered]                      | [Expected]                    |
| TC-004 | [Edge case]                 | [Mô tả edge case]                       | [Expected]                    |
| TC-005 | [Concurrency]               | Multiple concurrent requests            | No data corruption            |
| TC-006 | [Failure / Recovery]        | [Dependency down / crash mid-process]   | [Expected recovery behavior]  |
| TC-007 | [Idempotency]               | Same request twice                      | No duplicate side effects     |

---

## 14. Risks & Mitigations

| ID    | Risk                                        | Probability | Impact  | Mitigation                                 | Owner       |
|-------|---------------------------------------------|-------------|---------|-------------------------------------------|-------------|
| R-001 | [Database migration fails on production]    | Low         | High    | Test migration on staging, prepare rollback | DBA         |
| R-002 | [Third-party API unavailable]               | Medium      | Medium  | Implement circuit breaker + fallback       | Backend Dev |
| R-003 | [Performance degradation under peak load]   | Medium      | High    | Load test before release, auto-scaling     | DevOps      |
| R-004 | [Data inconsistency in async processing]    | Low         | High    | Idempotency key, exactly-once semantics    | Backend Dev |
| R-005 | [Security vulnerability in new endpoint]    | Low         | High    | Security review, penetration testing       | Security    |

---

## 15. Open Questions

{/* Các câu hỏi chưa có quyết định, cần làm rõ trước khi implement */}

| ID   | Question                                           | Status     | Decision By | Decision              |
|------|----------------------------------------------------|------------|-------------|------------------------|
| Q-01 | [Câu hỏi cần làm rõ 1]                            | Open       | [Owner]     | —                      |
| Q-02 | [Câu hỏi cần làm rõ 2]                            | Resolved   | [Owner]     | [Quyết định đã chọn]  |
| Q-03 | [Câu hỏi về business rule]                        | Open       | [Product]   | —                      |

---

{/* Không mention code và internal files */}

## Appendix: Glossary

| Term     | Definition          |
|----------|---------------------|
| [Term 1] | [Định nghĩa]        |
| [Term 2] | [Định nghĩa]        |

---

*Document maintained by [Team Name]. For questions, contact [email/Slack channel].*
