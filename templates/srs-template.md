# SRS Template — Generic English Example

> **Note for authors:** You may write your actual SRS in any language —
> the sd-author reads `config.language` and generates the Solution Design
> accordingly. This shipped template is a neutral English example only.

# **Feature: {{Feature name}} — {{System name}}**

# **I. Main Content**

## **1. Summary**

| Version | Author | Date | Change Summary |
| --- | --- | --- | --- |
|  |  |  |  |

- **Feature scope:** \<List the capabilities included in this feature>
- **Target users:** \<List the user roles or surfaces that interact with this feature>
- **Terminology:**

| Term | Definition |
| --- | --- |
|  |  |

## **2. Sequence Diagram**

\<Draw a high-level diagram showing the interactions and data flows between
actors, services, and components involved in this feature>

## **3. State Machine**

\<Draw the overall state diagram for this feature, and provide a table
describing the meaning of each state>

## **4. User Stories**

**US-1: \<Story name>**

- As a \<role>,
- I want to \<action>,
- So that I can \<outcome>.

#### Acceptance Criteria

\<List the conditions that must be true for this story to be considered
complete; write them so QA can verify each one independently>

#### Edge Cases

\<List uncommon or boundary-case scenarios that QA should also test for this
story>

## **5. Functional Requirements**

### **5.1. User Journey**

\<Describe how a user discovers and navigates through this feature, step by step>

### **5.2. Frontend Requirements**

\<Group requirements by surface (e.g. Admin Portal, End-User App, Operator
Dashboard). For each surface describe the screens and UI behaviours the user
interacts with directly.>

**Screen 1: \<Screen / view name>**

- **Purpose:**
- **Location in the app:**

| Label | Display type | Input type | Mandatory | Notes |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

- **Wireframe:**
\<Attach or embed a wireframe that matches the functional requirements above>

### **5.3. Business Logic**

\<Describe the processing rules, validation logic, calculation formulas, and
workflow conditions that the backend must enforce. Number each rule so they
can be traced to test cases.>

**BL-1:** \<Rule description>

**BL-2:** \<Rule description>

## **6. Non-Functional Requirements**

### **6.1. Security & Performance**

\<Table of NFR targets and how they will be measured>

| Requirement | Target | Measurement method |
| --- | --- | --- |
| Response time (p99) |  |  |
| Throughput |  |  |
| Authentication / authorisation |  |  |
| Data encryption |  |  |

### **6.2. Error & Notification Messages**

\<Tables describing error codes, warning messages, informational notices, and
any out-of-band notifications (email, SMS, in-app alert, etc.). Keep wording
concise and user-friendly.>

| Code / trigger | Message text | Channel | Audience |
| --- | --- | --- | --- |
|  |  |  |  |

# **II. Appendix**

\<Any additional detail that did not fit naturally in Part I — reference data,
third-party API contracts, regulatory references, open questions, etc.>
