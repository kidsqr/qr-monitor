import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runMaintenance } from '../scripts/maintain-schedule.mjs';

const API = 'https://api.github.com/repos/kidsqr/qr-monitor';
const NOW = new Date('2026-09-11T12:00:00.000Z');
const HEAD_SHA = '1111111111111111111111111111111111111111';
const TREE_SHA = '2222222222222222222222222222222222222222';
const NEW_SHA = '3333333333333333333333333333333333333333';

function validEnv(overrides = {}) {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'kidsqr/qr-monitor',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF:
      'kidsqr/qr-monitor/.github/workflows/maintenance.yml@refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_SHA: HEAD_SHA,
    INPUT_MODE: 'check',
    GITHUB_TOKEN: 'test-built-in-token',
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function repository(overrides = {}) {
  return {
    id: 123,
    node_id: 'R_public',
    name: 'qr-monitor',
    full_name: 'kidsqr/qr-monitor',
    private: false,
    owner: { login: 'kidsqr', id: 456, node_id: 'U_owner', type: 'User' },
    html_url: 'https://github.com/kidsqr/qr-monitor',
    url: API,
    default_branch: 'main',
    visibility: 'public',
    ...overrides,
  };
}

function reference(sha = HEAD_SHA, overrides = {}) {
  return {
    ref: 'refs/heads/main',
    node_id: 'REF_main',
    url: `${API}/git/refs/heads/main`,
    object: {
      type: 'commit',
      sha,
      url: `${API}/git/commits/${sha}`,
    },
    ...overrides,
  };
}

function commit(date, overrides = {}) {
  return {
    sha: HEAD_SHA,
    node_id: 'C_head',
    url: `${API}/git/commits/${HEAD_SHA}`,
    html_url: `https://github.com/kidsqr/qr-monitor/commit/${HEAD_SHA}`,
    author: { name: 'github-actions[bot]', email: 'bot@example.invalid', date },
    committer: { name: 'github-actions[bot]', email: 'bot@example.invalid', date },
    tree: { sha: TREE_SHA, url: `${API}/git/trees/${TREE_SHA}` },
    message: 'previous public repository activity',
    parents: [],
    verification: {
      verified: true,
      reason: 'valid',
      signature: null,
      payload: null,
      verified_at: date,
    },
    ...overrides,
  };
}

function createdCommit(overrides = {}) {
  return {
    sha: NEW_SHA,
    node_id: 'C_new',
    url: `${API}/git/commits/${NEW_SHA}`,
    html_url: `https://github.com/kidsqr/qr-monitor/commit/${NEW_SHA}`,
    author: { name: 'github-actions[bot]', email: 'bot@example.invalid', date: NOW.toISOString() },
    committer: { name: 'github-actions[bot]', email: 'bot@example.invalid', date: NOW.toISOString() },
    tree: { sha: TREE_SHA, url: `${API}/git/trees/${TREE_SHA}` },
    message: 'chore: maintain scheduled monitoring',
    parents: [
      {
        sha: HEAD_SHA,
        url: `${API}/git/commits/${HEAD_SHA}`,
        html_url: `https://github.com/kidsqr/qr-monitor/commit/${HEAD_SHA}`,
      },
    ],
    verification: {
      verified: true,
      reason: 'valid',
      signature: null,
      payload: null,
      verified_at: NOW.toISOString(),
    },
    ...overrides,
  };
}

function route(method, path, body, status = 200) {
  return { method, url: `${API}${path}`, response: jsonResponse(body, status) };
}

function queuedFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const expected = routes[calls.length];
    calls.push({ url: String(url), options });
    assert.ok(expected, `unexpected request ${options.method ?? 'GET'} ${url}`);
    assert.equal(options.method ?? 'GET', expected.method);
    assert.equal(String(url), expected.url);
    if (expected.response instanceof Error) throw expected.response;
    return expected.response;
  };
  return { fetchImpl, calls };
}

function readRoutes(date, repo = repository(), ref = reference(), gitCommit = commit(date)) {
  return [
    route('GET', '', repo),
    route('GET', '/git/ref/heads/main', ref),
    route('GET', `/git/commits/${HEAD_SHA}`, gitCommit),
  ];
}

test('rejects untrusted or malformed execution input before network access', async () => {
  const cases = [
    ['actions', { GITHUB_ACTIONS: 'false' }],
    ['repository', { GITHUB_REPOSITORY: 'someone/qr-monitor' }],
    ['ref', { GITHUB_REF: 'refs/heads/feature' }],
    ['workflow', { GITHUB_WORKFLOW_REF: 'kidsqr/qr-monitor/.github/workflows/other.yml@refs/heads/main' }],
    ['event', { GITHUB_EVENT_NAME: 'pull_request' }],
    ['mode', { INPUT_MODE: 'status' }],
    ['enable', { QR_MONITOR_MAINTENANCE_ENABLED: 'yes' }],
    ['sha', { GITHUB_SHA: 'not-a-sha' }],
    ['scheduled check', { GITHUB_EVENT_NAME: 'schedule', INPUT_MODE: 'check', QR_MONITOR_MAINTENANCE_ENABLED: '1' }],
  ];

  for (const [name, overrides] of cases) {
    let calls = 0;
    await assert.rejects(
      runMaintenance({
        env: validEnv(overrides),
        fetchImpl: async () => {
          calls += 1;
          throw new Error('network must remain unused');
        },
        now: () => NOW,
      }),
      { message: 'MAINTENANCE_REFUSED' },
      name,
    );
    assert.equal(calls, 0, name);
  }
});

test('reports disabled before network for scheduled or manual maintenance without the gate', async () => {
  for (const event of ['schedule', 'workflow_dispatch']) {
    let calls = 0;
    const status = await runMaintenance({
      env: validEnv({ GITHUB_EVENT_NAME: event, INPUT_MODE: 'maintain' }),
      fetchImpl: async () => {
        calls += 1;
        throw new Error('network must remain unused');
      },
      now: () => NOW,
    });
    assert.equal(status, 'disabled');
    assert.equal(calls, 0);
  }
});

test('reports a 30-day-old head due after three read-only fixed API requests', async () => {
  const date = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const fake = queuedFetch(readRoutes(date));

  const status = await runMaintenance({
    env: validEnv(),
    fetchImpl: fake.fetchImpl,
    now: () => NOW,
  });

  assert.equal(status, 'due');
  assert.equal(fake.calls.length, 3);
  for (const call of fake.calls) {
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.redirect, 'error');
    assert.match(call.options.headers.Authorization, /^Bearer /);
  }
});

test('reports a head younger than 30 days current without writes', async () => {
  const date = new Date(NOW.getTime() - 29 * 24 * 60 * 60 * 1000).toISOString();
  const fake = queuedFetch(readRoutes(date));

  const status = await runMaintenance({
    env: validEnv({
      GITHUB_EVENT_NAME: 'schedule',
      INPUT_MODE: 'maintain',
      QR_MONITOR_MAINTENANCE_ENABLED: '1',
    }),
    fetchImpl: fake.fetchImpl,
    now: () => NOW,
  });

  assert.equal(status, 'current');
  assert.equal(fake.calls.length, 3);
  assert.ok(fake.calls.every((call) => call.options.method === 'GET'));
});

test('at the exact 30-day boundary creates one same-tree child with force false and verifies the final head', async () => {
  const date = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const fake = queuedFetch([
    ...readRoutes(date),
    route('GET', '/git/ref/heads/main', reference()),
    route('POST', '/git/commits', createdCommit(), 201),
    route('PATCH', '/git/refs/heads/main', reference(NEW_SHA)),
    route('GET', '/git/ref/heads/main', reference(NEW_SHA)),
  ]);

  const status = await runMaintenance({
    env: validEnv({ INPUT_MODE: 'maintain', QR_MONITOR_MAINTENANCE_ENABLED: '1' }),
    fetchImpl: fake.fetchImpl,
    now: () => NOW,
  });

  assert.equal(status, 'maintained');
  assert.equal(fake.calls.length, 7);
  assert.deepEqual(JSON.parse(fake.calls[4].options.body), {
    message: 'chore: maintain scheduled monitoring',
    tree: TREE_SHA,
    parents: [HEAD_SHA],
  });
  assert.deepEqual(JSON.parse(fake.calls[5].options.body), {
    sha: NEW_SHA,
    force: false,
  });
});

test('refuses malformed and more-than-five-minutes-future commit dates', async () => {
  const dates = [
    'not-a-date',
    '2026-08-01',
    new Date(NOW.getTime() + 5 * 60 * 1000 + 1).toISOString(),
  ];

  for (const date of dates) {
    const fake = queuedFetch(readRoutes(date));
    await assert.rejects(
      runMaintenance({ env: validEnv(), fetchImpl: fake.fetchImpl, now: () => NOW }),
      { message: 'MAINTENANCE_REFUSED' },
    );
    assert.equal(fake.calls.length, 3);
  }
});

test('refuses impossible RFC3339 calendar, clock, and offset values before writes', async () => {
  const dates = [
    '2026-02-29T00:00:00Z',
    '1900-02-29T00:00:00Z',
    '2024-02-30T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T23:60:00Z',
    '2026-01-01T23:59:60Z',
    '2026-01-01T00:00:00+24:00',
    '2026-01-01T00:00:00-23:60',
  ];

  for (const date of dates) {
    const fake = queuedFetch(readRoutes(date));
    await assert.rejects(
      runMaintenance({
        env: validEnv({ INPUT_MODE: 'maintain', QR_MONITOR_MAINTENANCE_ENABLED: '1' }),
        fetchImpl: fake.fetchImpl,
        now: () => NOW,
      }),
      { message: 'MAINTENANCE_REFUSED' },
      date,
    );
    assert.equal(fake.calls.length, 3, date);
    assert.ok(fake.calls.every((call) => call.options.method === 'GET'), date);
  }
});

test('accepts valid RFC3339 leap-day and numeric-offset timestamps', async () => {
  const cases = [
    ['2024-02-29T23:59:59Z', new Date('2024-03-01T00:00:00Z')],
    ['2000-02-29T23:59:59Z', new Date('2000-03-01T00:00:00Z')],
    ['2026-09-11T20:30:00+09:00', NOW],
  ];

  for (const [date, now] of cases) {
    const fake = queuedFetch(readRoutes(date));
    const status = await runMaintenance({
      env: validEnv({ INPUT_MODE: 'maintain', QR_MONITOR_MAINTENANCE_ENABLED: '1' }),
      fetchImpl: fake.fetchImpl,
      now: () => now,
    });
    assert.equal(status, 'current', date);
    assert.equal(fake.calls.length, 3, date);
    assert.ok(fake.calls.every((call) => call.options.method === 'GET'), date);
  }
});

test('refuses unexpected public repository identity and shape', async () => {
  const cases = [
    repository({ private: true, visibility: 'private' }),
    repository({ default_branch: 'develop' }),
    repository({ full_name: 'kidsqr/another-repository' }),
    repository({ name: undefined }),
    repository({ url: undefined }),
  ];

  for (const repo of cases) {
    const fake = queuedFetch([route('GET', '', repo)]);
    await assert.rejects(
      runMaintenance({ env: validEnv(), fetchImpl: fake.fetchImpl, now: () => NOW }),
      { message: 'MAINTENANCE_REFUSED' },
    );
    assert.equal(fake.calls.length, 1);
  }
});

test('refuses unexpected main reference identity, type, or shape', async () => {
  const goodObject = reference().object;
  const cases = [
    reference(HEAD_SHA, { ref: 'refs/heads/other' }),
    reference(NEW_SHA),
    reference(HEAD_SHA, { object: { ...goodObject, type: 'tag' } }),
    reference(HEAD_SHA, { object: { ...goodObject, sha: 'bad' } }),
    reference(HEAD_SHA, { url: undefined }),
    reference(HEAD_SHA, { object: { ...goodObject, url: undefined } }),
  ];

  for (const ref of cases) {
    const fake = queuedFetch([
      route('GET', '', repository()),
      route('GET', '/git/ref/heads/main', ref),
    ]);
    await assert.rejects(
      runMaintenance({ env: validEnv(), fetchImpl: fake.fetchImpl, now: () => NOW }),
      { message: 'MAINTENANCE_REFUSED' },
    );
    assert.equal(fake.calls.length, 2);
  }
});

test('refuses unexpected commit identity, tree, or shape', async () => {
  const oldDate = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const cases = [
    commit(oldDate, { sha: NEW_SHA }),
    commit(oldDate, { tree: { sha: 'bad', url: `${API}/git/trees/bad` } }),
    commit(oldDate, { url: undefined }),
  ];

  for (const gitCommit of cases) {
    const fake = queuedFetch(readRoutes(oldDate, repository(), reference(), gitCommit));
    await assert.rejects(
      runMaintenance({ env: validEnv(), fetchImpl: fake.fetchImpl, now: () => NOW }),
      { message: 'MAINTENANCE_REFUSED' },
    );
    assert.equal(fake.calls.length, 3);
  }
});

test('refuses a changed head before creating any commit', async () => {
  const oldDate = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const fake = queuedFetch([
    ...readRoutes(oldDate),
    route('GET', '/git/ref/heads/main', reference(NEW_SHA)),
  ]);

  await assert.rejects(
    runMaintenance({
      env: validEnv({ INPUT_MODE: 'maintain', QR_MONITOR_MAINTENANCE_ENABLED: '1' }),
      fetchImpl: fake.fetchImpl,
      now: () => NOW,
    }),
    { message: 'MAINTENANCE_REFUSED' },
  );
  assert.equal(fake.calls.length, 4);
  assert.ok(fake.calls.every((call) => call.options.method === 'GET'));
});

test('refuses a 409 ref update without retrying or attempting cleanup', async () => {
  const oldDate = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const fake = queuedFetch([
    ...readRoutes(oldDate),
    route('GET', '/git/ref/heads/main', reference()),
    route('POST', '/git/commits', createdCommit(), 201),
    route('PATCH', '/git/refs/heads/main', { message: 'Conflict' }, 409),
  ]);

  await assert.rejects(
    runMaintenance({
      env: validEnv({ INPUT_MODE: 'maintain', QR_MONITOR_MAINTENANCE_ENABLED: '1' }),
      fetchImpl: fake.fetchImpl,
      now: () => NOW,
    }),
    { message: 'MAINTENANCE_REFUSED' },
  );
  assert.equal(fake.calls.length, 6);
  assert.deepEqual(fake.calls.map((call) => call.options.method), [
    'GET', 'GET', 'GET', 'GET', 'POST', 'PATCH',
  ]);
});

test('does not retry ambiguous commit creation or reference update failures', async () => {
  const oldDate = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const prefixes = [
    [
      ...readRoutes(oldDate),
      route('GET', '/git/ref/heads/main', reference()),
      { method: 'POST', url: `${API}/git/commits`, response: new Error('secret create failure') },
    ],
    [
      ...readRoutes(oldDate),
      route('GET', '/git/ref/heads/main', reference()),
      route('POST', '/git/commits', createdCommit(), 201),
      { method: 'PATCH', url: `${API}/git/refs/heads/main`, response: new Error('secret update failure') },
    ],
  ];

  for (const routes of prefixes) {
    const fake = queuedFetch(routes);
    await assert.rejects(
      runMaintenance({
        env: validEnv({ INPUT_MODE: 'maintain', QR_MONITOR_MAINTENANCE_ENABLED: '1' }),
        fetchImpl: fake.fetchImpl,
        now: () => NOW,
      }),
      { message: 'MAINTENANCE_FAILED' },
    );
    assert.equal(fake.calls.length, routes.length);
  }
});

test('treats a malformed successful update response as an ambiguous failure', async () => {
  const oldDate = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const fake = queuedFetch([
    ...readRoutes(oldDate),
    route('GET', '/git/ref/heads/main', reference()),
    route('POST', '/git/commits', createdCommit(), 201),
    route('PATCH', '/git/refs/heads/main', reference(HEAD_SHA)),
  ]);

  await assert.rejects(
    runMaintenance({
      env: validEnv({ INPUT_MODE: 'maintain', QR_MONITOR_MAINTENANCE_ENABLED: '1' }),
      fetchImpl: fake.fetchImpl,
      now: () => NOW,
    }),
    { message: 'MAINTENANCE_FAILED' },
  );
  assert.equal(fake.calls.length, 6);
});

test('rejects non-JSON and oversized API responses before another request', async () => {
  const tooLarge = jsonResponse({ padding: 'x'.repeat(64 * 1024) });
  const declaredTooLarge = new Response('{}', {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-length': String(64 * 1024 + 1),
    },
  });
  const wrongMediaType = new Response(JSON.stringify(repository()), {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  });

  for (const response of [tooLarge, declaredTooLarge, wrongMediaType]) {
    const fake = queuedFetch([{ method: 'GET', url: API, response }]);
    await assert.rejects(
      runMaintenance({ env: validEnv(), fetchImpl: fake.fetchImpl, now: () => NOW }),
      { message: 'MAINTENANCE_FAILED' },
    );
    assert.equal(fake.calls.length, 1);
  }
});

test('turns timeout, HTTP, and malformed JSON details into one fixed failure', async () => {
  const timeoutCalls = [];
  const timeoutFetch = (url, options) => {
    timeoutCalls.push({ url, options });
    return new Promise((resolve, reject) => {
      options.signal.addEventListener(
        'abort',
        () => reject(new Error('secret timeout detail must not escape')),
        { once: true },
      );
    });
  };
  await assert.rejects(
    runMaintenance({
      env: validEnv(),
      fetchImpl: timeoutFetch,
      now: () => NOW,
      requestTimeoutMs: 5,
      totalTimeoutMs: 100,
    }),
    (error) => error.message === 'MAINTENANCE_FAILED' && !String(error).includes('secret'),
  );
  assert.equal(timeoutCalls.length, 1);

  const failures = [
    new Response(JSON.stringify({ message: 'secret provider detail' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    }),
    new Response('{not json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ];
  for (const response of failures) {
    const fake = queuedFetch([{ method: 'GET', url: API, response }]);
    await assert.rejects(
      runMaintenance({ env: validEnv(), fetchImpl: fake.fetchImpl, now: () => NOW }),
      (error) => error.message === 'MAINTENANCE_FAILED' && !String(error).includes('secret'),
    );
    assert.equal(fake.calls.length, 1);
  }
});

test('turns an injected clock exception into a fixed failure before network access', async () => {
  let calls = 0;
  await assert.rejects(
    runMaintenance({
      env: validEnv(),
      fetchImpl: async () => {
        calls += 1;
        throw new Error('network must remain unused');
      },
      now: () => {
        throw new Error('secret clock detail');
      },
    }),
    (error) => error.message === 'MAINTENANCE_FAILED' && !String(error).includes('secret'),
  );
  assert.equal(calls, 0);
});

test('fails ambiguous created-commit identity, tree, or parent verification without updating the ref', async () => {
  const oldDate = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const cases = [
    createdCommit({ url: undefined }),
    createdCommit({ tree: { sha: '4444444444444444444444444444444444444444', url: `${API}/git/trees/4444444444444444444444444444444444444444` } }),
    createdCommit({ parents: [{ sha: NEW_SHA, url: `${API}/git/commits/${NEW_SHA}` }] }),
  ];

  for (const created of cases) {
    const fake = queuedFetch([
      ...readRoutes(oldDate),
      route('GET', '/git/ref/heads/main', reference()),
      route('POST', '/git/commits', created, 201),
    ]);
    await assert.rejects(
      runMaintenance({
        env: validEnv({ INPUT_MODE: 'maintain', QR_MONITOR_MAINTENANCE_ENABLED: '1' }),
        fetchImpl: fake.fetchImpl,
        now: () => NOW,
      }),
      { message: 'MAINTENANCE_FAILED' },
    );
    assert.equal(fake.calls.length, 5);
    assert.equal(fake.calls.at(-1).options.method, 'POST');
  }
});

test('refuses when final verification no longer observes the created commit at main', async () => {
  const oldDate = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const fake = queuedFetch([
    ...readRoutes(oldDate),
    route('GET', '/git/ref/heads/main', reference()),
    route('POST', '/git/commits', createdCommit(), 201),
    route('PATCH', '/git/refs/heads/main', reference(NEW_SHA)),
    route('GET', '/git/ref/heads/main', reference(HEAD_SHA)),
  ]);

  await assert.rejects(
    runMaintenance({
      env: validEnv({ INPUT_MODE: 'maintain', QR_MONITOR_MAINTENANCE_ENABLED: '1' }),
      fetchImpl: fake.fetchImpl,
      now: () => NOW,
    }),
    { message: 'MAINTENANCE_REFUSED' },
  );
  assert.equal(fake.calls.length, 7);
});

test('CLI emits only a fixed refusal and never echoes untrusted values', () => {
  const script = fileURLToPath(new URL('../scripts/maintain-schedule.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'attacker/private-secret-name',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_WORKFLOW_REF:
        'kidsqr/qr-monitor/.github/workflows/maintenance.yml@refs/heads/main',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_SHA: HEAD_SHA,
      INPUT_MODE: 'check',
      GITHUB_TOKEN: 'super-secret-token',
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'MAINTENANCE_REFUSED\n');
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secret|attacker/i);
});
