'use strict';
// Every compose and log call goes to an in-memory fake. Nothing here runs docker,
// ngrok or cloudflared.
const test = require('node:test');
const assert = require('node:assert/strict');
const { BadRequest } = require('../helper-core/helperServer');
const { createTunnels, SERVICES } = require('./tunnels');

const T0 = Date.parse('2026-11-12T10:00:00Z');
const DOMAIN = 'friends-game.ngrok-free.app';
const TOKEN = '2abcSECRETtoken9xyz_QWERTY';
const PROFILE = { cloudflared: 'tunnel-cf', 'cloudflared-prod': 'tunnel-cf-prod', ngrok: 'tunnel', 'ngrok-prod': 'tunnel-prod' };
const TUNNEL_SERVICES = Object.keys(PROFILE);
// Every bare word a call may contain: verbs, their values, profiles, our services and web.
const ALLOWED_WORDS = new Set(['up', 'rm', 'ps', 'logs', 'json', 'web', ...TUNNEL_SERVICES, ...Object.values(PROFILE)]);

// A fake compose project: `rows` are its containers, `logText[service]` their logs.
function harness({ rows = [], logText = {}, upFail = null } = {}) {
  let t = T0;
  const calls = [];
  const logCalls = [];
  const state = { rows: rows.map((r) => ({ ...r })), logText: { ...logText } };
  async function compose(args) {
    calls.push(args);
    const verb = ['up', 'rm', 'ps', 'logs'].find((v) => args.includes(v));
    const named = args.filter((a) => a === 'web' || TUNNEL_SERVICES.includes(a));
    if (verb === 'ps') {
      const out = state.rows.filter((r) => !named.length || named.includes(r.Service));
      return { code: 0, stdout: out.map((r) => JSON.stringify(r)).join('\n'), stderr: '' };
    }
    if (verb === 'up') {
      if (upFail && named.includes(upFail.service)) return { code: 1, stdout: '', stderr: upFail.stderr };
      for (const s of named) {
        state.rows = state.rows.filter((r) => r.Service !== s);
        state.rows.push({ Service: s, State: 'running', ExitCode: 0, Created: Math.floor(t / 1000) });
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    if (verb === 'rm') {
      state.rows = state.rows.filter((r) => !named.includes(r.Service));
      return { code: 0, stdout: '', stderr: '' };
    }
    if (verb === 'logs') return { code: 0, stdout: state.logText[named[0]] || '', stderr: '' };
    throw new Error(`unexpected compose call ${args.join(' ')}`);
  }
  async function logs(service) {
    logCalls.push(service);
    const v = state.logText[service];
    return typeof v === 'function' ? v() : (v || '');
  }
  const opts = {
    compose, logs, ngrokDomain: DOMAIN, secrets: [TOKEN],
    now: () => t, sleep: async (ms) => { t += ms; },
  };
  return { calls, logCalls, state, opts, advance: (ms) => { t += ms; }, now: () => t };
}

// Every call that names a profile-gated service passes that service's profile, and names
// nothing but the four tunnel services and `web`.
function assertCallsScoped(calls) {
  for (const args of calls) {
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i];
      if (a.startsWith('-')) continue;
      assert.ok(ALLOWED_WORDS.has(a), `call names something outside the tunnel services: ${args.join(' ')}`);
    }
    for (const s of TUNNEL_SERVICES) {
      if (!args.includes(s)) continue;
      const profiles = args.flatMap((a, i) => (a === '--profile' ? [args[i + 1]] : []));
      assert.ok(profiles.includes(PROFILE[s]), `${s} named without --profile ${PROFILE[s]}: ${args.join(' ')}`);
    }
  }
}
const joined = (calls) => calls.map((a) => a.join(' '));

// Log lines as the real agents print them. ngrok v3 logfmt needs --log=stdout (set in compose).
const at = 't=2026-11-12T10:00:01+0000';
const NG_BOOT = [
  `${at} lvl=info msg="no configuration paths supplied"`,
  `${at} lvl=info msg="starting web service" obj=web addr=0.0.0.0:4040 allow_hosts=[]`,
].join('\n') + '\n';
const ngStarted = (addr) => NG_BOOT + [
  `${at} lvl=info msg="client session established" obj=tunnels.session`,
  `${at} lvl=info msg="tunnel session started" obj=tunnels.session`,
  `${at} lvl=info msg="started tunnel" obj=tunnels name=command_line addr=${addr} url=https://${DOMAIN}`,
].join('\n') + '\n';
const NG_BUSY = NG_BOOT + [
  `${at} lvl=eror msg="failed to reconnect session" obj=tunnels.session obj=csess id=4f2a9c err="authentication failed: Your account is limited to 1 simultaneous ngrok agent sessions.\\nYou can run multiple simultaneous tunnels from a single agent session by defining the tunnels in your agent configuration file and starting them with the command \`ngrok start --all\`.\\r\\n\\r\\nERR_NGROK_108\\r\\n"`,
  'ERROR:  authentication failed: Your account is limited to 1 simultaneous ngrok agent sessions.',
  'ERROR:  ERR_NGROK_108',
].join('\n') + '\n';
const NG_ONLINE = NG_BOOT + [
  `${at} lvl=eror msg="session closing" obj=tunnels.session err="failed to start tunnel: The endpoint 'https://${DOMAIN}' is already online.\\r\\n\\r\\nERR_NGROK_334\\r\\n"`,
  'ERROR:  failed to start tunnel: The endpoint is already online.',
  'ERROR:  ERR_NGROK_334',
].join('\n') + '\n';
const cfBox = (url) => [
  '2026-11-12T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
  '2026-11-12T10:00:04Z INF +--------------------------------------------------------------------------------------------+',
  '2026-11-12T10:00:04Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
  `2026-11-12T10:00:04Z INF |  ${url}                                                            |`,
  '2026-11-12T10:00:04Z INF +--------------------------------------------------------------------------------------------+',
].join('\n') + '\n';
const CF_REQUEST_FAILED = [
  '2026-11-12T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
  '2026-11-12T10:00:05Z ERR Error unmarshaling QuickTunnel response: error="invalid character \'e\' looking for beginning of value" status_code="500 Internal Server Error"',
  '2026-11-12T10:00:05Z failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com on 127.0.0.11:53: server misbehaving',
].join('\n') + '\n';

test('start cloudflare built: rebuilds web, recreates cloudflared-prod, reads the address', async () => {
  const h = harness({ logText: { 'cloudflared-prod': 'INF Requesting new quick Tunnel\nINF |  https://a-b.trycloudflare.com  |\n' } });
  const tunnels = createTunnels(h.opts);
  const st = await tunnels.start('cloudflare', 'built');
  const c = joined(h.calls);
  const web = c.indexOf('--profile tunnel-cf-prod up -d --build --no-deps web');
  const cf = c.indexOf('--profile tunnel-cf-prod up -d --no-deps --force-recreate cloudflared-prod');
  assert.ok(web >= 0, c.join('\n'));
  assert.ok(cf > web, c.join('\n'));
  assert.deepEqual(st, {
    provider: 'cloudflare', state: 'on', mode: 'built', url: 'https://a-b.trycloudflare.com',
    startedAt: new Date(T0).toISOString(), error: null,
  });
  const { events, next } = tunnels.events(0);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'started');
  assert.equal(events[0].provider, 'cloudflare');
  assert.equal(next, events[0].id);
  assertCallsScoped(h.calls);
});

test('no address within the wait: failed, container removed, event recorded', async () => {
  const h = harness({ logText: { cloudflared: 'INF Starting tunnel\nERR failed to request quick Tunnel\n' } });
  const tunnels = createTunnels(h.opts);
  const st = await tunnels.start('cloudflare', 'live');
  assert.equal(st.state, 'failed');
  assert.equal(st.url, null);
  assert.match(st.error, /40 s/);
  const c = joined(h.calls);
  assert.ok(c.includes('--profile tunnel-cf rm -sf cloudflared'), c.join('\n'));
  assert.ok(!c.some((x) => x.includes(' web')), 'live mode never touches web');
  assert.ok(h.now() - T0 >= 40000, 'waited the full 40 s');
  const ev = tunnels.events(0).events;
  assert.deepEqual(ev.map((e) => e.kind), ['failed']);
  assert.match(ev[0].detail, /40 s/);
  assert.equal(h.state.rows.length, 0);
  assertCallsScoped(h.calls);
});

test('ngrok busy: refused by another session, own container removed, nothing else named', async () => {
  const h = harness({
    rows: [{ Service: 'cloudflared', State: 'running', ExitCode: 0, Created: Math.floor(T0 / 1000) - 60 }],
    logText: {
      cloudflared: 'INF |  https://keep-me.trycloudflare.com  |\n',
      ngrok: NG_BUSY,
    },
  });
  const tunnels = createTunnels(h.opts);
  const st = await tunnels.start('ngrok', 'live');
  assert.equal(st.state, 'busy');
  assert.equal(st.error, 'ngrok is busy with another project');
  assert.equal(st.url, null);
  const c = joined(h.calls);
  assert.ok(c.includes('--profile tunnel rm -sf ngrok'), c.join('\n'));
  assert.ok(!c.some((x) => / rm .*cloudflared/.test(x)), 'cloudflare never removed');
  assert.deepEqual(tunnels.events(0).events.map((e) => [e.provider, e.kind]), [['ngrok', 'busy']]);
  assert.ok(!JSON.stringify([st, tunnels.events(0)]).includes(TOKEN));
  assert.ok(!h.state.rows.some((r) => r.Service === 'ngrok'));
  assertCallsScoped(h.calls);
});

test('ERR_NGROK_334 (endpoint already online) also reads as busy', async () => {
  const h = harness({ logText: { 'ngrok-prod': NG_ONLINE } });
  const st = await createTunnels(h.opts).start('ngrok', 'built');
  assert.equal(st.state, 'busy');
  assert.equal(st.error, 'ngrok is busy with another project');
});

test('stop touches only its own services', async () => {
  const h = harness({
    logText: {
      cloudflared: 'INF |  https://c-d.trycloudflare.com  |\n',
      'ngrok-prod': ngStarted('http://web:80'),
    },
  });
  const tunnels = createTunnels(h.opts);
  const cf = await tunnels.start('cloudflare', 'live');
  const ng = await tunnels.start('ngrok', 'built');
  assert.equal(cf.state, 'on');
  assert.equal(ng.state, 'on');
  assert.equal(ng.url, `https://${DOMAIN}`);
  h.calls.length = 0;
  const off = await tunnels.stop('ngrok');
  assert.deepEqual(h.calls, [['--profile', 'tunnel-prod', 'rm', '-sf', 'ngrok-prod']]);
  assert.equal(off.state, 'off');
  assert.equal(off.url, null);
  const after = await tunnels.status();
  assert.deepEqual(after.cloudflare, cf);
  assert.ok(h.state.rows.some((r) => r.Service === 'cloudflared'));
  assert.ok(h.state.rows.some((r) => r.Service === 'web'), 'web is shared, never removed by a stop');
  const kinds = tunnels.events(0).events.map((e) => [e.provider, e.kind]);
  assert.deepEqual(kinds, [['cloudflare', 'started'], ['ngrok', 'started'], ['ngrok', 'stopped']]);
  assertCallsScoped(h.calls);
});

test('adopts a running container after restart', async () => {
  const created = Math.floor(T0 / 1000) - 3600;
  const h = harness({
    rows: [{ Service: 'cloudflared', State: 'running', ExitCode: 0, Created: created }],
    logText: {
      cloudflared: 'INF |  https://kept-alive.trycloudflare.com  |\nINF Registered tunnel connection connIndex=0\n'
        + 'ERR Connection terminated connIndex=0\nINF Registered tunnel connection connIndex=0\n',
    },
  });
  const tunnels = createTunnels(h.opts);
  const st = await tunnels.status();
  assert.deepEqual(st.cloudflare, {
    provider: 'cloudflare', state: 'on', mode: 'live', url: 'https://kept-alive.trycloudflare.com',
    startedAt: new Date(created * 1000).toISOString(), error: null,
  });
  assert.equal(st.ngrok.state, 'off');
  assert.ok(!joined(h.calls).some((x) => / up /.test(` ${x} `)), 'no up call');
  assert.ok(!joined(h.calls).some((x) => / rm /.test(` ${x} `)), 'no rm call');
  await tunnels.status();
  assert.deepEqual(tunnels.events(0).events, [], 'an outage from before the restart is not replayed');
  // A start after adoption is a no-op, not a recreate.
  h.calls.length = 0;
  assert.deepEqual(await tunnels.start('cloudflare', 'built'), st.cloudflare);
  assert.ok(!joined(h.calls).some((x) => / up /.test(` ${x} `)));
  assertCallsScoped(h.calls);
});

test('adoption reads the CreatedAt text when Created is not a number', async () => {
  const h = harness({ rows: [{ Service: 'ngrok', State: 'running', ExitCode: 0, CreatedAt: '2026-11-12 08:30:05 +0000 UTC' }] });
  const st = await createTunnels(h.opts).status();
  assert.equal(st.ngrok.state, 'on');
  assert.equal(st.ngrok.mode, 'live');
  assert.equal(st.ngrok.url, `https://${DOMAIN}`);
  assert.equal(st.ngrok.startedAt, '2026-11-12T08:30:05.000Z');
});

test('dropped and reconnected: one event each per outage', async () => {
  let text = '2026-11-12T10:00:01Z ERR Failed to dial a quic connection error="timeout: no recent network activity" connIndex=0\n'
    + '2026-11-12T10:00:01Z INF Retrying connection in up to 2s connIndex=0\n'
    + cfBox('https://e-f.trycloudflare.com');
  const h = harness({ logText: { cloudflared: () => text } });
  const tunnels = createTunnels(h.opts);
  assert.equal((await tunnels.start('cloudflare', 'live')).url, 'https://e-f.trycloudflare.com');
  text += '2026-11-12T10:00:05Z INF Registered tunnel connection connIndex=0 connection=1a2b event=0 ip=198.41.200.13 location=fra08 protocol=quic\n'
    + '2026-11-12T10:00:05Z INF Registered tunnel connection connIndex=1 connection=3c4d event=0 ip=198.41.192.7 location=ams01 protocol=quic\n';
  await tunnels.status();
  assert.deepEqual(tunnels.events(0).events.map((e) => e.kind), ['started'], 'start-up retries and registrations are not an outage');
  text += 'ERR Connection terminated error="timeout: no recent network activity" connIndex=0\n'
    + 'INF Retrying connection in up to 1s connIndex=0\n'
    + 'ERR Serve tunnel error error="timeout" connIndex=1\n';
  await tunnels.status();
  await tunnels.status();
  text += 'INF Registered tunnel connection connIndex=0\nINF Registered tunnel connection connIndex=1\n';
  await tunnels.status();
  await tunnels.status();
  const ev = tunnels.events(0).events;
  assert.deepEqual(ev.map((e) => e.kind), ['started', 'dropped', 'reconnected']);
  assert.ok(ev.every((e) => e.provider === 'cloudflare'));
  // The cursor works: events(since) returns only what is newer.
  const tail = tunnels.events(ev[0].id);
  assert.deepEqual(tail.events.map((e) => e.kind), ['dropped', 'reconnected']);
  assert.equal(tail.next, ev[2].id);
  assert.deepEqual(tunnels.events(tail.next), { events: [], next: tail.next });
});

test('ngrok session loss and re-establishment are dropped/reconnected', async () => {
  let text = ngStarted('http://frontend:5173');
  const h = harness({ logText: { ngrok: () => text } });
  const tunnels = createTunnels(h.opts);
  assert.equal((await tunnels.start('ngrok', 'live')).state, 'on');
  text += `${at} lvl=eror msg="heartbeat timeout, terminating session" obj=tunnels.session clientid=8c1e\n`
    + `${at} lvl=info msg="session closed, starting reconnect loop" obj=tunnels.session err="session closed"\n`
    + `${at} lvl=eror msg="failed to reconnect session" obj=tunnels.session err="dial tcp: lookup connect.ngrok-agent.com: i/o timeout"\n`;
  await tunnels.status();
  text += `${at} lvl=info msg="client session established" obj=tunnels.session\n${at} lvl=info msg="tunnel session started" obj=tunnels.session\n`;
  await tunnels.status();
  assert.deepEqual(tunnels.events(0).events.map((e) => e.kind), ['started', 'dropped', 'reconnected']);
});

test('start while on returns the current state with no compose call', async () => {
  const h = harness({ logText: { cloudflared: 'INF |  https://g-h.trycloudflare.com  |\n' } });
  const tunnels = createTunnels(h.opts);
  const on = await tunnels.start('cloudflare', 'live');
  h.calls.length = 0;
  h.logCalls.length = 0;
  assert.deepEqual(await tunnels.start('cloudflare', 'live'), on);
  assert.deepEqual(await tunnels.start('cloudflare', 'built'), on);
  assert.deepEqual(h.calls, []);
  assert.equal(tunnels.events(0).events.length, 1);
});

test('unknown provider or mode throws BadRequest', async () => {
  const h = harness();
  const tunnels = createTunnels(h.opts);
  await assert.rejects(tunnels.start('tor', 'live'), BadRequest);
  await assert.rejects(tunnels.start('ngrok', 'staging'), BadRequest);
  await assert.rejects(tunnels.start('ngrok'), BadRequest);
  await assert.rejects(tunnels.start('__proto__', 'live'), BadRequest);
  await assert.rejects(tunnels.stop('web'), BadRequest);
  assert.deepEqual(h.calls, []);
});

test('NGROK_AUTHTOKEN value never reaches state, events or errors', async () => {
  // An unknown ngrok refusal quotes its log line; the compose stderr of a failed build is quoted too.
  const h = harness({
    logText: { ngrok: `ERROR:  authentication failed: The authtoken you specified does not look like a proper ngrok tunnel authtoken. the credential '${TOKEN}' was rejected\nERROR:  ERR_NGROK_105\n` },
    upFail: { service: 'web', stderr: `failed to solve: secret ${TOKEN} denied` },
  });
  const tunnels = createTunnels(h.opts);
  const a = await tunnels.start('ngrok', 'live');
  assert.equal(a.state, 'failed');
  assert.match(a.error, /ERR_NGROK_105/);
  const b = await tunnels.start('cloudflare', 'built');
  assert.equal(b.state, 'failed');
  assert.match(b.error, /web/);
  const everything = JSON.stringify([a, b, await tunnels.status(), tunnels.events(0)]);
  assert.ok(!everything.includes(TOKEN), everything);
  assert.ok(everything.includes('***'), 'redaction marker present, i.e. the token was there to hide');
});

test('ngrok is one card: a leftover of the other mode is removed before starting', async () => {
  const h = harness({
    rows: [{ Service: 'ngrok-prod', State: 'exited', ExitCode: 1, Created: Math.floor(T0 / 1000) - 99 }],
    logText: { ngrok: ngStarted('http://frontend:5173') },
  });
  const st = await createTunnels(h.opts).start('ngrok', 'live');
  assert.equal(st.state, 'on');
  const c = joined(h.calls);
  const rm = c.indexOf('--profile tunnel-prod rm -sf ngrok-prod');
  const up = c.indexOf('--profile tunnel up -d --no-deps --force-recreate ngrok');
  assert.ok(rm >= 0 && up > rm, c.join('\n'));
  assertCallsScoped(h.calls);
});

test('ngrok is one card: the other mode running is adopted, not replaced', async () => {
  const h = harness({ rows: [{ Service: 'ngrok-prod', State: 'running', ExitCode: 0, Created: Math.floor(T0 / 1000) - 99 }] });
  const st = await createTunnels(h.opts).start('ngrok', 'live');
  assert.equal(st.state, 'on');
  assert.equal(st.mode, 'built');
  assert.ok(!joined(h.calls).some((x) => / (up|rm) /.test(` ${x} `)), joined(h.calls).join('\n'));
});

test('a tunnel whose container went away turns off; a crash is a failed event, a clean exit is not', async () => {
  const h = harness({ logText: { cloudflared: 'INF |  https://i-j.trycloudflare.com  |\n', ngrok: ngStarted('http://frontend:5173') } });
  const tunnels = createTunnels(h.opts);
  await tunnels.start('cloudflare', 'live');
  await tunnels.start('ngrok', 'live');
  h.state.rows.find((r) => r.Service === 'cloudflared').State = 'exited';
  h.state.rows.find((r) => r.Service === 'cloudflared').ExitCode = 1;
  h.state.rows = h.state.rows.filter((r) => r.Service !== 'ngrok'); // e.g. make down
  h.calls.length = 0;
  const st = await tunnels.status();
  assert.equal(st.cloudflare.state, 'off');
  assert.equal(st.ngrok.state, 'off');
  const ev = tunnels.events(0).events.map((e) => [e.provider, e.kind]);
  assert.deepEqual(ev, [['cloudflare', 'started'], ['ngrok', 'started'], ['cloudflare', 'failed']]);
  assert.ok(!joined(h.calls).some((x) => / up /.test(` ${x} `)), 'never restarted');
});

test('a stuck ngrok agent (running, no started tunnel line) is not on: failed after the wait', async () => {
  const h = harness({ logText: { ngrok: NG_BOOT } });
  const tunnels = createTunnels(h.opts);
  const st = await tunnels.start('ngrok', 'live');
  assert.equal(st.state, 'failed');
  assert.equal(st.url, null);
  assert.match(st.error, /within 40 s/);
  assert.ok(joined(h.calls).includes('--profile tunnel rm -sf ngrok'));
  assert.deepEqual(tunnels.events(0).events.map((e) => e.kind), ['failed']);
});

test('cloudflared failure line naming api.trycloudflare.com is not an address', async () => {
  const h = harness({ logText: { cloudflared: CF_REQUEST_FAILED } });
  const tunnels = createTunnels(h.opts);
  const st = await tunnels.start('cloudflare', 'live');
  assert.equal(st.state, 'failed');
  assert.equal(st.url, null);
  assert.ok(!JSON.stringify(tunnels.events(0)).includes('https://api.'));
  // Adopting a container whose log holds only that line never shows it as the address.
  const a = harness({ rows: [{ Service: 'cloudflared', State: 'running', ExitCode: 0, Created: 1 }], logText: { cloudflared: CF_REQUEST_FAILED } });
  const adopted = (await createTunnels(a.opts).status()).cloudflare;
  assert.notEqual(adopted.url, 'https://api.trycloudflare.com');
  assert.equal(adopted.url, null);
  // A real box after a failed attempt still yields the real address, not the API host.
  const b = harness({ logText: { cloudflared: CF_REQUEST_FAILED + cfBox('https://m-n.trycloudflare.com') } });
  assert.equal((await createTunnels(b.opts).start('cloudflare', 'live')).url, 'https://m-n.trycloudflare.com');
});

test('stop during starting: no failed event and no second rm when the wait would have ended', async () => {
  const h = harness({ logText: { cloudflared: '2026-11-12T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...\n' } });
  let tunnels;
  let stopped = null;
  const realSleep = h.opts.sleep;
  tunnels = createTunnels({
    ...h.opts,
    sleep: async (ms) => { await realSleep(ms); if (!stopped) stopped = await tunnels.stop('cloudflare'); },
  });
  const st = await tunnels.start('cloudflare', 'live');
  assert.equal(stopped.state, 'off');
  assert.equal(st.state, 'off');
  assert.ok(h.now() - T0 < 40000, 'gave up as soon as it saw the stop');
  assert.equal(joined(h.calls).filter((x) => x.includes(' rm ')).length, 1, joined(h.calls).join('\n'));
  assert.ok(!tunnels.events(0).events.some((e) => e.kind === 'failed'));
  assert.equal((await tunnels.status()).cloudflare.state, 'off');
});

test('default logs reader goes through compose with the service profile', async () => {
  const h = harness({ logText: { 'cloudflared-prod': 'INF |  https://k-l.trycloudflare.com  |\n' } });
  const { logs, ...rest } = h.opts;
  const st = await createTunnels(rest).start('cloudflare', 'built');
  assert.equal(st.url, 'https://k-l.trycloudflare.com');
  assert.ok(joined(h.calls).includes('--profile tunnel-cf-prod logs --no-log-prefix cloudflared-prod'));
  assertCallsScoped(h.calls);
});

test('SERVICES maps each card and mode to its service and profile', () => {
  assert.deepEqual(SERVICES, {
    cloudflare: { live: { service: 'cloudflared', profile: 'tunnel-cf' }, built: { service: 'cloudflared-prod', profile: 'tunnel-cf-prod' } },
    ngrok: { live: { service: 'ngrok', profile: 'tunnel' }, built: { service: 'ngrok-prod', profile: 'tunnel-prod' } },
  });
});
