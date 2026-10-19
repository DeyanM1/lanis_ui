const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const axios = require('axios');
const values = new Map();
const storage = {
  get length() { return values.size; },
  key(index) { return [...values.keys()][index] ?? null; },
  getItem(key) { return values.get(key) ?? null; },
  setItem(key, value) { values.set(key, String(value)); },
  removeItem(key) { values.delete(key); },
};
const window = { localStorage: storage, location: { pathname: '/messages', href: '' }, addEventListener() {}, setInterval() { return 1; }, clearInterval() {} };
const context = { window, localStorage: storage, navigator: {}, console, URL, document: { cookie: '' }, setTimeout, clearTimeout, Blob, FormData };
const modules = new Map();
function load(relative) {
  const filename = path.resolve(__dirname, '../src', relative);
  if (modules.has(filename)) return modules.get(filename);
  const exports = {};
  modules.set(filename, exports);
  let source = fs.readFileSync(filename, 'utf8').replaceAll('import.meta.env', '({})');
  if (relative === 'services/api.ts') source += '\nexport { apiClient as testClient };';
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, {
    ...context, exports, require(name) {
      if (name === 'axios') return axios;
      if (name.includes('demo/mockApi')) return { getMockResponse() { throw Error('Unexpected demo request'); } };
      return load(path.relative(path.resolve(__dirname, '../src'), path.resolve(path.dirname(filename), name + '.ts')));
    },
  }, { filename });
  return exports;
}
const lifecycle = load('utils/accountDataWrites.ts');
const { testClient } = load('services/api.ts');
const keys = ['messages_cache', 'profile_cache', 'courses_cache', 'username_cache', 'dsb_plan_cache_v2'];
function login(username) {
  const generation = lifecycle.captureAccountDataGeneration();
  assert(lifecycle.completeAccountDataDeletion(generation));
  storage.setItem('auth_access_token', username + '-token');
  storage.setItem('auth_refresh_token', username + '-refresh');
  storage.setItem('auth_expires_at', String(Date.now() + 3600000));
  storage.setItem('auth_user', JSON.stringify({ school_id: '123', username }));
}
function deferredRequest(status = 200, token = storage.getItem('auth_access_token')) {
  let settle;
  const started = new Promise(resolve => {
    const adapter = config => new Promise((resolveResponse, reject) => {
      settle = () => status === 200
        ? resolveResponse({ data: { secret: 'A' }, status, headers: {}, config })
        : reject(new axios.AxiosError('HTTP error', undefined, config, {}, { status, config }));
      resolve();
    });
    deferredRequest.result = testClient.get('/private', { headers: { 'X-Session-Token': token }, adapter });
    // Attach a handler before deliberately rejecting the deferred response.
    deferredRequest.result.catch(() => {});
  });
  return { started, finish: () => settle(), result: () => deferredRequest.result };
}
(async () => {
  login('A');
  const generationA = lifecycle.captureAccountDataGeneration();
  for (const key of keys) {
    storage.setItem(key, JSON.stringify({ secret: 'legacy-A' }));
    assert.equal(lifecycle.readPersonalCache(key), null, 'Legacy unowned caches must not render');
    lifecycle.writePersonalCache(key, 'private-A', generationA);
    assert.equal(lifecycle.readPersonalCache(key), 'private-A');
  }
  storage.setItem('modules_cache:123:A', 'private-modules');
  storage.setItem('lanis_preferences:123:A', 'private-preferences');
  storage.setItem('__demo_storage_snapshot', 'private-snapshot');
  storage.setItem('lanis_theme_color', 'ruby');
  storage.setItem('lanis_custom_backend_url', 'https://custom.invalid');
  const pending = deferredRequest();
  await pending.started;
  lifecycle.clearSignedOutAccountData();
  for (const key of [...keys, 'auth_access_token', 'auth_user', 'modules_cache:123:A', 'lanis_preferences:123:A', '__demo_storage_snapshot']) assert.equal(storage.getItem(key), null, key);
  assert.equal(storage.getItem('lanis_theme_color'), 'ruby');
  assert.equal(storage.getItem('lanis_custom_backend_url'), 'https://custom.invalid');
  assert(!lifecycle.canWriteAccountData(generationA));
  lifecycle.writePersonalCache('profile_cache', 'late-A', generationA);
  assert.equal(storage.getItem('profile_cache'), null);
  login('B');
  pending.finish();
  await assert.rejects(pending.result(), axios.isCancel);
  lifecycle.writePersonalCache('profile_cache', 'late-A', generationA);
  assert.equal(lifecycle.readPersonalCache('profile_cache'), null);
  lifecycle.writePersonalCache('profile_cache', 'private-B', lifecycle.captureAccountDataGeneration());
  assert.equal(lifecycle.readPersonalCache('profile_cache'), 'private-B');
  // Account identity is checked independently of the generation.
  storage.setItem('auth_user', JSON.stringify({ school_id: '456', username: 'B' }));
  assert.equal(lifecycle.readPersonalCache('profile_cache'), null);
  const old401 = deferredRequest(401);
  await old401.started;
  lifecycle.clearSignedOutAccountData();
  login('C');
  old401.finish();
  await assert.rejects(old401.result(), axios.isCancel);
  assert.equal(storage.getItem('auth_access_token'), 'C-token', 'Old 401 must not log out the new account');
  const valid = deferredRequest();
  await valid.started;
  valid.finish();
  assert.equal((await valid.result()).data.secret, 'A', 'Current-session responses remain usable');
  storage.setItem('auth_access_token', 'C-rotated');
  const rotated = deferredRequest(200, 'C-token');
  await rotated.started;
  rotated.finish();
  assert.equal((await rotated.result()).config.headers['X-Session-Token'], 'C-rotated', 'React may retain a token rotated within this session');
  await assert.rejects(testClient.get('/private', { headers: { 'X-Session-Token': 'A-token' } }), axios.isCancel);
  const temporary = deferredRequest(503);
  await temporary.started;
  temporary.finish();
  await assert.rejects(temporary.result());
  assert.equal(storage.getItem('auth_access_token'), 'C-rotated');
  // Terminal authentication loss uses the same private-data cleanup boundary.
  storage.removeItem('auth_refresh_token');
  lifecycle.writePersonalCache('messages_cache', 'private-C', lifecycle.captureAccountDataGeneration());
  const terminal = deferredRequest(401);
  await terminal.started;
  terminal.finish();
  await assert.rejects(terminal.result());
  assert.equal(storage.getItem('messages_cache'), null);
  assert.equal(storage.getItem('auth_user'), null);
  assert.equal(window.location.href, '/login');
  console.log('Logout/account cache and real Axios interceptor regression checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
