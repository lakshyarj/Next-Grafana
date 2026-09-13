// Exercises the security-critical pure logic in lib/grafana.ts.
process.env.GRAFANA_URL = 'http://13.203.193.234:30016';
process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN = 'glsa_test_token_value_1234567890';
process.env.GRAFANA_ORG_ID = '1';
process.env.GRAFANA_PATH_PREFIX = '/api/grafana';

const { getGrafanaConfig, buildUpstreamUrl, sanitiseSearch, GrafanaConfigError } =
  await import('../lib/grafana.ts');

let pass = 0, fail = 0;
const eq = (name, actual, expected) => {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`${ok ? ' ok  ' : ' FAIL'} ${name}${ok ? '' : `\n        expected: ${expected}\n        actual:   ${actual}`}`);
};
const throws = (name, fn) => {
  try { fn(); fail++; console.log(` FAIL ${name} (no throw)`); }
  catch (e) { e instanceof GrafanaConfigError ? (pass++, console.log(` ok   ${name}`)) : (fail++, console.log(` FAIL ${name} (wrong error: ${e.name})`)); }
};

// --- audit-token stripping -------------------------------------------------
eq('sanitiseSearch strips auth_token',
   sanitiseSearch('auth_token=SECRET&kiosk=1'), 'kiosk=1');
eq('sanitiseSearch strips access_token',
   sanitiseSearch('access_token=SECRET'), '');
eq('sanitiseSearch strips authtoken (no underscore)',
   sanitiseSearch('authtoken=SECRET'), '');
eq('sanitiseSearch preserves legitimate params',
   sanitiseSearch('from=now-1h&to=now&var-x=1'), 'from=now-1h&to=now&var-x=1');
eq('sanitiseSearch passes empty through', sanitiseSearch(''), '');

// --- topology A: bare origin (recommended) ---------------------------------
let cfg = getGrafanaConfig();
eq('normalises bare origin', cfg.baseUrl, 'http://13.203.193.234:30016');
eq('non-strip target', buildUpstreamUrl(cfg, ['d', 'ad8hd5h', 'dashboard'], ''),
   'http://13.203.193.234:30016/api/grafana/d/ad8hd5h/dashboard');
eq('non-strip target keeps query',
   buildUpstreamUrl(cfg, ['api', 'health'], 'a=1'), 'http://13.203.193.234:30016/api/grafana/api/health?a=1');

// --- topology B: operator pasted the sub-path (double-prefix hazard) -------
process.env.GRAFANA_URL = 'http://13.203.193.234:30016/api/grafana';
cfg = getGrafanaConfig();
eq('sub-path in GRAFANA_URL is normalised away', cfg.baseUrl, 'http://13.203.193.234:30016');
eq('no doubled prefix', buildUpstreamUrl(cfg, ['public', 'build', 'app.js'], ''),
   'http://13.203.193.234:30016/api/grafana/public/build/app.js');

// --- topology C: strip mode ------------------------------------------------
process.env.GRAFANA_URL = 'http://13.203.193.234:30016';
process.env.GRAFANA_STRIP_PATH_PREFIX = 'true';
cfg = getGrafanaConfig();
eq('strip mode drops the prefix',
   buildUpstreamUrl(cfg, ['public', 'build', 'app.js'], ''),
   'http://13.203.193.234:30016/public/build/app.js');

// --- traversal rejection ---------------------------------------------------
throws('rejects ".." segment', () => buildUpstreamUrl(cfg, ['..', 'etc', 'passwd'], ''));
throws('rejects embedded ".."', () => buildUpstreamUrl(cfg, ['a..b'], ''));
throws('rejects "." segment', () => buildUpstreamUrl(cfg, ['.'], ''));

// --- config validation -----------------------------------------------------
process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN = '';
throws('throws when token missing', () => getGrafanaConfig());
process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN = 'glsa_test_token_value_1234567890';
process.env.GRAFANA_URL = 'ftp://nope.example';
throws('rejects non-http scheme', () => getGrafanaConfig());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
