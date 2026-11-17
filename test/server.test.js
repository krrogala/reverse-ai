import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { UpstreamError } from '../src/errors.js';
import { createApp, parseAllowedHosts } from '../src/server.js';

async function withApp({ askClaude = async () => '{"message":"q"}', ...deps }, fn) {
  const provider = { name: 'fake', model: 'fake-1', ask: askClaude };
  const server = createApp({ log: () => {}, provider, allowedHosts: [], ...deps });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const postTurn = (base, body, headers = { 'content-type': 'application/json' }) =>
  fetch(`${base}/api/turn`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

const reply = (fields) => async () => JSON.stringify({ message: 'q', rating: null, note: '', action: 'continue', ...fields });

test('serves the console and its assets', async () => {
  await withApp({}, async (base) => {
    for (const path of ['/', '/styles.css', '/app.js', '/render.js', '/fonts/fonts.css', '/fonts/inter-normal.woff2']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
    }
    assert.match(await (await fetch(base)).text(), /Human-1/);
  });
});

test('returns 404 for unknown and traversal paths', async () => {
  await withApp({}, async (base) => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
  });
});

test('refuses requests that are not from the local console', async () => {
  await withApp({ askClaude: reply({}) }, async (base) => {
    // fetch() will not let a caller forge Host, so use a raw request for the rebinding case.
    const reboundStatus = await new Promise((resolve, reject) => {
      const req = request(`${base}/api/config`, { headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(reboundStatus, 403);
    const crossSite = await postTurn(base, { transcript: [] }, {
      'content-type': 'application/json',
      origin: 'https://evil.example',
    });
    assert.equal(crossSite.status, 403);
    const sameOrigin = await postTurn(base, { transcript: [] }, { 'content-type': 'application/json', origin: base });
    assert.equal(sameOrigin.status, 200);
  });
});

test('exposes the token limit and which model plays the user', async () => {
  await withApp({}, async (base) => {
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(typeof config.tokenLimit, 'number');
    assert.equal(config.provider, 'fake');
    assert.equal(config.model, 'fake-1');
  });
});

test('opening turn never carries a rating or regenerate', async () => {
  await withApp({ askClaude: reply({ message: 'fix my css', rating: 'down', note: 'Bad', action: 'regenerate' }) }, async (base) => {
    const res = await postTurn(base, { transcript: [] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { message: 'fix my css', rating: null, note: '', action: 'continue' });
  });
});

test('opening turn with no message is an upstream failure, not a blank thread', async () => {
  await withApp({ askClaude: reply({ message: '', action: 'regenerate' }) }, async (base) => {
    assert.equal((await postTurn(base, { transcript: [] })).status, 502);
  });
});

test('later turns pass the transcript to Claude and relay its feedback', async () => {
  let seenPrompt = '';
  const askClaude = async (prompt) => {
    seenPrompt = prompt;
    return JSON.stringify({ message: '', rating: 'down', note: 'Too slow', action: 'regenerate' });
  };
  await withApp({ askClaude }, async (base) => {
    const transcript = [
      { role: 'asker', text: 'capital of peru' },
      { role: 'human', text: 'Lima I think', latencyMs: 61000, attempt: 1 },
    ];
    const res = await postTurn(base, { transcript });
    assert.deepEqual(await res.json(), { message: '', rating: 'down', note: 'Too slow', action: 'regenerate' });
    assert.match(seenPrompt, /Lima I think/);
    assert.match(seenPrompt, /61s/);
  });
});

test('rejects invalid input', async () => {
  await withApp({ askClaude: reply({}) }, async (base) => {
    assert.equal((await postTurn(base, { transcript: 'nope' })).status, 400);
    assert.equal((await postTurn(base, '{not json')).status, 400);
    assert.equal((await postTurn(base, { transcript: [] }, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await postTurn(base, { transcript: [], pad: 'x'.repeat(300 * 1024) })).status, 413);
  });
});

test('maps Claude failures to a 502 with a hint and no internals', async () => {
  const askClaude = async () => {
    throw new UpstreamError('Failed to authenticate: secret detail', 'not_signed_in');
  };
  await withApp({ askClaude }, async (base) => {
    const res = await postTurn(base, { transcript: [] });
    const body = await res.json();
    assert.equal(res.status, 502);
    assert.match(body.error, /claude auth login/);
    assert.doesNotMatch(body.error, /secret detail/);
  });
});

test('maps an unusable reply to a 502', async () => {
  await withApp({ askClaude: async () => '   ' }, async (base) => {
    assert.equal((await postTurn(base, { transcript: [] })).status, 502);
  });
});

test('limits concurrent turns', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const askClaude = async () => {
    await gate;
    return JSON.stringify({ message: 'q' });
  };
  await withApp({ askClaude }, async (base) => {
    const first = postTurn(base, { transcript: [] });
    const second = postTurn(base, { transcript: [] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const third = await postTurn(base, { transcript: [] });
    assert.equal(third.status, 429);
    release();
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
  });
});

const rawGet = (base, host) =>
  new Promise((resolve, reject) => {
    const req = request(`${base}/api/config`, { headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });

test('accepts extra hosts when deployed behind a name', async () => {
  await withApp({ allowedHosts: parseAllowedHosts(' Human1.example.com , box:8080,') }, async (base) => {
    assert.equal(await rawGet(base, 'human1.example.com'), 200);
    assert.equal(await rawGet(base, 'box:8080'), 200);
    assert.equal(await rawGet(base, 'other.example.com'), 403);
    const viaTls = await new Promise((resolve, reject) => {
      const headers = { host: 'human1.example.com', origin: 'https://human1.example.com', 'content-type': 'application/json' };
      const req = request(`${base}/api/turn`, { method: 'POST', headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end(JSON.stringify({ transcript: [] }));
    });
    assert.equal(viaTls, 200);
  });
});

test('does not serve files outside the static index', async () => {
  await withApp({}, async (base) => {
    assert.equal((await fetch(`${base}/fonts/../../package.json`)).status, 404);
    assert.equal((await fetch(`${base}/fonts/`)).status, 404);
  });
});

test('maps each upstream failure kind to its own hint', async () => {
  for (const [kind, pattern] of [['bad_key', /API key/], ['rate_limited', /rate limited/], ['refused', /declined/], ['timeout', /too long/]]) {
    const askClaude = async () => {
      throw new UpstreamError('internal detail', kind);
    };
    await withApp({ askClaude }, async (base) => {
      const res = await postTurn(base, { transcript: [] });
      assert.equal(res.status, 502);
      assert.match((await res.json()).error, pattern);
    });
  }
});
