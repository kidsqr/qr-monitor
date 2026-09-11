import { pathToFileURL } from 'node:url';

const REPOSITORY = 'kidsqr/qr-monitor';
const API_ROOT = `https://api.github.com/repos/${REPOSITORY}`;
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/maintenance.yml@refs/heads/main`;
const MAIN_REF = 'refs/heads/main';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_RESPONSE_BYTES = 64 * 1024;

class MaintenanceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MaintenanceError';
  }
}

function refuse() {
  throw new MaintenanceError('MAINTENANCE_REFUSED');
}

function fail() {
  throw new MaintenanceError('MAINTENANCE_FAILED');
}

function validateInputs(env) {
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    env.GITHUB_REF !== MAIN_REF ||
    env.GITHUB_WORKFLOW_REF !== WORKFLOW_REF ||
    !SHA_PATTERN.test(env.GITHUB_SHA ?? '') ||
    !['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
  ) {
    refuse();
  }

  const mode = env.INPUT_MODE;
  if (!['check', 'maintain'].includes(mode)) refuse();
  if (env.GITHUB_EVENT_NAME === 'schedule' && mode !== 'maintain') refuse();

  const enabled = env.QR_MONITOR_MAINTENANCE_ENABLED;
  if (enabled !== undefined && enabled !== '' && enabled !== '1') refuse();
  if (typeof env.GITHUB_TOKEN !== 'string' || env.GITHUB_TOKEN.length === 0) refuse();

  return { mode, enabled: enabled === '1' };
}

async function readBoundedJson(response) {
  const mediaType = (response.headers.get('content-type') ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== 'application/json' && !mediaType.endsWith('+json')) fail();

  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES) fail();
  }
  if (response.body === null) fail();

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        fail();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    fail();
  }

  try {
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(data));
  } catch {
    fail();
  }
}

function validateRepository(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    value.name !== 'qr-monitor' ||
    value.full_name !== REPOSITORY ||
    value.private !== false ||
    value.visibility !== 'public' ||
    value.default_branch !== 'main' ||
    value.url !== API_ROOT
  ) {
    refuse();
  }
}

function validateReference(value, expectedSha, invalid = refuse) {
  if (
    value === null ||
    typeof value !== 'object' ||
    value.ref !== MAIN_REF ||
    value.url !== `${API_ROOT}/git/refs/heads/main` ||
    value.object === null ||
    typeof value.object !== 'object' ||
    value.object.type !== 'commit' ||
    !SHA_PATTERN.test(value.object.sha ?? '') ||
    value.object.url !== `${API_ROOT}/git/commits/${value.object.sha}` ||
    (expectedSha !== undefined && value.object.sha !== expectedSha)
  ) {
    invalid();
  }
  return value.object.sha;
}

function validateCommit(value, expectedSha, nowMs) {
  if (
    value === null ||
    typeof value !== 'object' ||
    value.sha !== expectedSha ||
    value.url !== `${API_ROOT}/git/commits/${expectedSha}` ||
    value.committer === null ||
    typeof value.committer !== 'object' ||
    typeof value.committer.date !== 'string' ||
    !RFC3339_PATTERN.test(value.committer.date) ||
    value.tree === null ||
    typeof value.tree !== 'object' ||
    !SHA_PATTERN.test(value.tree.sha ?? '') ||
    !Array.isArray(value.parents)
  ) {
    refuse();
  }

  const committedAt = Date.parse(value.committer.date);
  if (!Number.isFinite(committedAt) || committedAt > nowMs + FUTURE_TOLERANCE_MS) refuse();
  return { committedAt, treeSha: value.tree.sha };
}

function validateCreatedCommit(value, expectedTreeSha, expectedParentSha) {
  if (
    value === null ||
    typeof value !== 'object' ||
    !SHA_PATTERN.test(value.sha ?? '') ||
    value.sha === expectedParentSha ||
    value.url !== `${API_ROOT}/git/commits/${value.sha}` ||
    value.message !== 'chore: maintain scheduled monitoring' ||
    value.tree === null ||
    typeof value.tree !== 'object' ||
    value.tree.sha !== expectedTreeSha ||
    !Array.isArray(value.parents) ||
    value.parents.length !== 1 ||
    value.parents[0] === null ||
    typeof value.parents[0] !== 'object' ||
    value.parents[0].sha !== expectedParentSha
  ) {
    fail();
  }
  return value.sha;
}

function requestClient({ fetchImpl, token, totalSignal, requestTimeoutMs }) {
  return async function request(method, path, body) {
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response;
    try {
      response = await fetchImpl(`${API_ROOT}${path}`, {
        method,
        headers,
        redirect: 'error',
        signal: AbortSignal.any([totalSignal, AbortSignal.timeout(requestTimeoutMs)]),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      fail();
    }
    if (!response || typeof response.ok !== 'boolean') fail();
    if (!response.ok) {
      if (method === 'PATCH' && response.status === 409) refuse();
      fail();
    }
    return readBoundedJson(response);
  };
}

export async function runMaintenance({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  requestTimeoutMs = 10_000,
  totalTimeoutMs = 120_000,
} = {}) {
  const { mode, enabled } = validateInputs(env);
  if (mode === 'maintain' && !enabled) return 'disabled';
  if (typeof fetchImpl !== 'function') refuse();

  let currentTime;
  try {
    currentTime = now();
  } catch {
    fail();
  }
  const nowMs = currentTime instanceof Date ? currentTime.getTime() : Number(currentTime);
  if (!Number.isFinite(nowMs)) refuse();
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 10_000) refuse();
  if (!Number.isFinite(totalTimeoutMs) || totalTimeoutMs <= 0 || totalTimeoutMs > 120_000) refuse();

  const request = requestClient({
    fetchImpl,
    token: env.GITHUB_TOKEN,
    totalSignal: AbortSignal.timeout(totalTimeoutMs),
    requestTimeoutMs,
  });

  const repo = await request('GET', '');
  validateRepository(repo);
  const ref = await request('GET', '/git/ref/heads/main');
  const headSha = validateReference(ref);
  if (headSha !== env.GITHUB_SHA) refuse();
  const gitCommit = await request('GET', `/git/commits/${headSha}`);
  const { committedAt, treeSha } = validateCommit(gitCommit, headSha, nowMs);

  if (nowMs - committedAt < THIRTY_DAYS_MS) return 'current';
  if (mode === 'check') return 'due';

  const currentRef = await request('GET', '/git/ref/heads/main');
  validateReference(currentRef, headSha);

  const createdCommit = await request('POST', '/git/commits', {
    message: 'chore: maintain scheduled monitoring',
    tree: treeSha,
    parents: [headSha],
  });
  const createdSha = validateCreatedCommit(createdCommit, treeSha, headSha);

  const updatedRef = await request('PATCH', '/git/refs/heads/main', {
    sha: createdSha,
    force: false,
  });
  validateReference(updatedRef, createdSha, fail);

  const finalRef = await request('GET', '/git/ref/heads/main');
  validateReference(finalRef, createdSha);
  return 'maintained';
}

async function main() {
  try {
    const status = await runMaintenance();
    process.stdout.write(`${status}\n`);
  } catch (error) {
    const code =
      error instanceof MaintenanceError ? error.message : 'MAINTENANCE_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
