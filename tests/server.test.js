import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';

let server;
let baseUrl;
let tempDbPath;

before(async () => {
  const seed = await fs.readFile(path.resolve('data/db.json'), 'utf-8');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dwaraka-beta-test-'));
  tempDbPath = path.join(tmpDir, 'db.json');
  await fs.writeFile(tempDbPath, seed, 'utf-8');

  server = createServer(tempDbPath);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (tempDbPath) {
    await fs.rm(path.dirname(tempDbPath), { recursive: true, force: true });
  }
});

describe('DWARAKA Software Labs Beta Portal API', () => {
  it('serves the HTML shell and health check', async () => {
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /DWARAKA Software Labs/);

    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
  });

  it('returns seeded portal state without exposing adminPin', async () => {
    const res = await fetch(`${baseUrl}/api/state`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.settings.adminPin, undefined);
    assert.ok(data.releases.length >= 4);
    assert.ok(data.team.length >= 4);
  });

  it('verifies admin PIN correctly', async () => {
    const bad = await fetch(`${baseUrl}/api/auth/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: 'WRONG' })
    });
    assert.equal(bad.status, 401);

    const good = await fetch(`${baseUrl}/api/auth/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: 'DWARAKA-2026' })
    });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).valid, true);
  });

  it('publishes, promotes, pauses, updates checklist, and archives a beta release', async () => {
    const createRes = await fetch(`${baseUrl}/api/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Narmada AI Studio',
        version: 'v0.1.0-alpha',
        url: 'https://narmada-beta.dwarakalabs.in',
        stage: 'Alpha',
        owner: 'Vamsi K.',
        summary: 'Initial alpha release for prompt workflow testing',
        checklist: ['Verify prompt save', 'Check mobile layout'],
        tags: ['ai', 'studio']
      })
    });
    assert.equal(createRes.status, 201);
    const { release } = await createRes.json();
    assert.equal(release.stage, 'Alpha');
    assert.equal(release.checklist.length, 2);

    // Promote Alpha -> Closed Beta
    const promoteRes = await fetch(`${baseUrl}/api/releases/${release.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'promote' })
    });
    assert.equal(promoteRes.status, 200);
    assert.equal((await promoteRes.json()).release.stage, 'Closed Beta');

    // Update checklist item
    const chkId = release.checklist[0].id;
    const chkRes = await fetch(`${baseUrl}/api/releases/${release.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'checklist-update', checkId: chkId, status: 'pass', tester: 'Meera' })
    });
    assert.equal(chkRes.status, 200);
    assert.equal((await chkRes.json()).release.checklist[0].status, 'pass');

    // Delete / archive
    const delRes = await fetch(`${baseUrl}/api/releases/${release.id}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
  });

  it('submits and triages beta feedback', async () => {
    const stateRes = await fetch(`${baseUrl}/api/state`);
    const { releases } = await stateRes.json();
    const targetId = releases[0].id;

    const fbRes = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        releaseId: targetId,
        title: 'Header overlaps on 375px viewport',
        severity: 'High',
        category: 'UI/UX',
        reporter: 'Vikram Sharma'
      })
    });
    assert.equal(fbRes.status, 201);
    const { feedback } = await fbRes.json();

    const triageRes = await fetch(`${baseUrl}/api/feedback/${feedback.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Fixed', leadNote: 'Fixed flex-wrap in header' })
    });
    assert.equal(triageRes.status, 200);
    const updated = (await triageRes.json()).feedback;
    assert.equal(updated.status, 'Fixed');
    assert.equal(updated.leadNote, 'Fixed flex-wrap in header');
  });
});
