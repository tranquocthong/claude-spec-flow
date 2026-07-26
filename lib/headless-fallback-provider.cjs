/**
 * headless-fallback-provider.cjs — HeadlessFallbackProvider.
 *
 * Minimal HTTP LLM client used ONLY when there is no host agent and
 * headlessFallback is configured. Parses the LLM response into a task array
 * and delegates to TaskImporter for the validated + atomic write layer.
 *
 * Implements FR-009, FR-010 (SD §9.2 headless fallback path):
 *   - execute(op, params, fallbackConfig, _inject) — main entry point.
 *   - Validates fallbackConfig fields before any network I/O.
 *   - Injectable HTTP transport (_inject._httpPost) so unit tests make ZERO
 *     real network calls (NFR-002).
 *   - When _inject._httpPost is absent, defaults to Node 18+ global fetch
 *     (lazy — the default client is never constructed until first use, so
 *     when headless fallback is unused, no HTTP client is initialised, FR-010).
 *
 * parseTasksFromResponse tolerates three response shapes:
 *   1. data is an Array                          → direct task array
 *   2. data.tasks is an Array                    → nested under tasks key
 *   3. data.choices[0].message.content (string)  → OpenAI chat format,
 *      JSON-encoded task array inside the content string
 *
 * Error code ERR_AI_FALLBACK_FAILED is set on all operational failures
 * (non-2xx status, unparseable JSON, no task array found).
 *
 * Public API:
 *   execute(op, params, fallbackConfig, _inject) → Promise<{ imported: number }>
 *   parseTasksFromResponse(data)                  → Array|null   (exported for tests)
 *   buildMessages(op, params)                     → Array        (exported for tests)
 *
 * Zero external dependencies — pure Node CommonJS (FR-003).
 */
'use strict';

const { importTasks } = require('./task-importer.cjs');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Assert that fallbackConfig is a plain object with non-empty string fields
 * endpoint, model, and apiKey. Throws a clear Error when any is missing.
 *
 * @param {*} cfg - value to validate
 * @throws {Error} when cfg is null/non-object or any required field is missing
 */
function assertFallbackConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    const e = new Error(
      'fallbackConfig is required and must be an object with endpoint, model, and apiKey'
    );
    e.code = 'ERR_AI_FALLBACK_FAILED';
    throw e;
  }

  for (const field of ['endpoint', 'model', 'apiKey']) {
    if (typeof cfg[field] !== 'string' || cfg[field].length === 0) {
      const e = new Error(
        `fallbackConfig.${field} must be a non-empty string; got: ${JSON.stringify(cfg[field])}`
      );
      e.code = 'ERR_AI_FALLBACK_FAILED';
      throw e;
    }
  }
}

/**
 * Build the messages array for the LLM chat completion request.
 *
 * The system message instructs the LLM to return a JSON array of tasks.
 * The user message includes the operation name and serialized params as context.
 *
 * @param {string} op     - AI operation name (e.g. 'parse-prd', 'expand')
 * @param {object} params - operation parameters (tag, input, id, etc.)
 * @returns {Array<{ role: string, content: string }>}
 */
function buildMessages(op, params) {
  const systemContent = [
    'You are a task planning assistant. Generate a JSON array of tasks.',
    'Each task must include all required fields:',
    '  id (string), title (string, non-empty), description (string, non-empty),',
    '  status ("pending"), priority ("low"|"medium"|"high"),',
    '  dependencies (array of strings), subtasks (array), updatedAt (ISO-8601 string).',
    'Return ONLY the raw JSON array. Do not wrap it in markdown code fences.',
    'Do not include any explanation outside the JSON.',
  ].join(' ');

  const userContent = 'Operation: ' + op + '\nContext: ' + JSON.stringify(params);

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];
}

/**
 * Parse a task array from an LLM HTTP response body.
 *
 * Tolerates three response shapes (in priority order):
 *   1. data is an Array                          → returned directly
 *   2. data.tasks is an Array                    → returned as-is
 *   3. data.choices[0].message.content (string)  → JSON-parsed; accepts Array or
 *      object with .tasks; both yield the task array
 *
 * Returns null when no task array can be found (caller decides to throw).
 * Throws ERR_AI_FALLBACK_FAILED when choices content is present but invalid JSON.
 *
 * @param {*} data - parsed JSON from the LLM HTTP response
 * @returns {Array|null}
 * @throws {Error} with .code='ERR_AI_FALLBACK_FAILED' on JSON parse failure in content
 */
function parseTasksFromResponse(data) {
  // Shape 1: data itself is an array
  if (Array.isArray(data)) {
    return data;
  }

  if (!data || typeof data !== 'object') {
    return null;
  }

  // Shape 2: data.tasks is an array
  if (Array.isArray(data.tasks)) {
    return data.tasks;
  }

  // Shape 3: data.choices[0].message.content — OpenAI chat completion format
  if (
    Array.isArray(data.choices) &&
    data.choices.length > 0 &&
    data.choices[0].message &&
    typeof data.choices[0].message.content === 'string'
  ) {
    const content = data.choices[0].message.content;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (jsonErr) {
      const e = new Error(
        'headless fallback: choices[0].message.content is not valid JSON — ' + jsonErr.message
      );
      e.code = 'ERR_AI_FALLBACK_FAILED';
      throw e;
    }

    if (Array.isArray(parsed)) {
      return parsed;
    }
    // Tolerate { tasks: [...] } nested inside the JSON content string
    if (parsed && Array.isArray(parsed.tasks)) {
      return parsed.tasks;
    }
    return null;
  }

  // No recognisable shape found
  return null;
}

/**
 * Default HTTP POST client using Node 18+ global fetch.
 *
 * This function is ONLY used in production code paths. Unit tests always supply
 * _inject._httpPost and never reach this function (NFR-002: zero real network
 * calls in tests). The function is defined lazily at call time — no HTTP client
 * is constructed at module-load time — so when headless fallback is unused in
 * production the default transport is never initialised (FR-010 zero-network).
 *
 * @param {string} url
 * @param {{ headers: object, body: string }} options
 * @returns {Promise<{ status: number, json: * }>}
 */
async function defaultHttpPost(url, options) {
  // fetch is a global in Node 18+. The assignment is deferred to call time
  // so that module-level code never touches fetch (FR-010).
  const response = await fetch(url, {
    method: 'POST',
    headers: options.headers,
    body: options.body,
  });
  const json = await response.json();
  return { status: response.status, json };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a headless LLM AI operation and import the resulting tasks.
 *
 * Sequence (FR-009, FR-010):
 *   1. Validate fallbackConfig — throws before any I/O if invalid.
 *   2. Select transport: _inject._httpPost (tests) or defaultHttpPost (production).
 *   3. Build and send the chat completion request.
 *   4. Assert HTTP 2xx; throw ERR_AI_FALLBACK_FAILED on non-2xx.
 *   5. Parse the task array from the response body.
 *   6. Assert a task array was found; throw ERR_AI_FALLBACK_FAILED if not.
 *   7. Delegate to importTasks (validated + atomic write); return its result.
 *
 * @param {string} op              - AI operation name (e.g. 'parse-prd', 'expand')
 * @param {object} params          - operation params; params.tag is required by importTasks
 * @param {object} fallbackConfig  - { endpoint: string, model: string, apiKey: string }
 * @param {object} [_inject]       - { _httpPost?: Function, _paths?: object } for test isolation
 * @returns {Promise<{ imported: number }>}
 * @throws {Error} with .code='ERR_AI_FALLBACK_FAILED' on any failure
 */
async function execute(op, params, fallbackConfig, _inject) {
  // Step 1: Validate fallbackConfig BEFORE any HTTP I/O (TC-009 guarantee).
  assertFallbackConfig(fallbackConfig);

  const { endpoint, model, apiKey } = fallbackConfig;

  // Step 2: Select HTTP transport.
  //   When _inject._httpPost is provided (always in tests), use it exclusively —
  //   this is the only transport that executes in tests (NFR-002).
  //   When absent (production path), use the lazy defaultHttpPost.
  const httpPost =
    _inject && typeof _inject._httpPost === 'function'
      ? _inject._httpPost
      : defaultHttpPost;

  // Step 3: Build request payload.
  const messages = buildMessages(op, params);
  const requestBody = JSON.stringify({ model, messages });
  const headers = {
    Authorization: 'Bearer ' + apiKey,
    'Content-Type': 'application/json',
  };

  // Step 4: Perform the HTTP POST.
  let response;
  try {
    response = await httpPost(endpoint, { headers, body: requestBody });
  } catch (networkErr) {
    const e = new Error(
      'headless fallback: HTTP request failed — ' + networkErr.message
    );
    e.code = 'ERR_AI_FALLBACK_FAILED';
    throw e;
  }

  // Step 5: Assert HTTP 2xx.
  if (response.status < 200 || response.status >= 300) {
    const e = new Error(
      'headless fallback: LLM API returned non-2xx status ' + response.status
    );
    e.code = 'ERR_AI_FALLBACK_FAILED';
    throw e;
  }

  // Step 6: Parse tasks from the response body.
  //   parseTasksFromResponse may throw ERR_AI_FALLBACK_FAILED (invalid JSON in content).
  const tasks = parseTasksFromResponse(response.json);

  if (!Array.isArray(tasks)) {
    const e = new Error(
      'headless fallback: LLM response did not contain a parseable task array ' +
      '(expected Array, { tasks }, or choices[0].message.content JSON)'
    );
    e.code = 'ERR_AI_FALLBACK_FAILED';
    throw e;
  }

  // Step 7: Delegate to TaskImporter — validated + atomic write layer (task 3).
  //   Pass _paths through for test isolation so writes go to the tmp directory.
  const _paths = _inject && _inject._paths;
  return importTasks(params.tag, tasks, undefined, _paths);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  execute,
  parseTasksFromResponse, // exported for direct unit testing
  buildMessages,          // exported for direct unit testing
};
