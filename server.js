import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const APKS_DIR = path.join(__dirname, 'apks');
const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'db.json');
const VERCEL_TMP_DB_PATH = path.join(os.tmpdir(), 'dwaraka-beta-db.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.apk': 'application/vnd.android.package-archive'
};

const STAGE_ORDER = ['Alpha', 'Closed Beta', 'Open Beta', 'RC', 'Deprecated'];

async function ensureDbPath(dbPath) {
  if (!process.env.VERCEL || dbPath !== DEFAULT_DB_PATH) {
    return dbPath;
  }
  try {
    await fs.access(VERCEL_TMP_DB_PATH);
    return VERCEL_TMP_DB_PATH;
  } catch {
    const seedPaths = [
      DEFAULT_DB_PATH,
      path.join(process.cwd(), 'data', 'db.json')
    ];
    for (const candidate of seedPaths) {
      try {
        const seed = await fs.readFile(candidate, 'utf-8');
        await fs.writeFile(VERCEL_TMP_DB_PATH, seed, 'utf-8');
        return VERCEL_TMP_DB_PATH;
      } catch {
        // try next seed path
      }
    }
    throw new Error('Seed database file data/db.json not found.');
  }
}

async function readDb(dbPath) {
  const targetPath = await ensureDbPath(dbPath);
  const raw = await fs.readFile(targetPath, 'utf-8');
  return JSON.parse(raw);
}

async function writeDb(dbPath, data) {
  const targetPath = await ensureDbPath(dbPath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, JSON.stringify(data, null, 2), 'utf-8');
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }
  if (typeof req.body === 'string') {
    return req.body.trim() ? JSON.parse(req.body) : {};
  }
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function addActivity(db, type, actor, message) {
  db.activity.unshift({
    id: `act-${crypto.randomUUID().slice(0, 8)}`,
    type,
    actor: actor || 'Labs System',
    message,
    timestamp: new Date().toISOString()
  });
  if (db.activity.length > 60) {
    db.activity = db.activity.slice(0, 60);
  }
}

function sanitizeUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return '';
  const trimmed = urlStr.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / 1024 ** idx;
  return `${val.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function parseApkFilename(filename) {
  const base = filename.replace(/\.apk$/i, '');
  const versionMatch = base.match(/[-_](v?\d+\.\d+(?:\.\d+)?(?:[-._][a-z0-9]+)?)$/i);
  const version = versionMatch ? versionMatch[1] : 'v1.0.0-beta';
  const rawName = versionMatch ? base.slice(0, versionMatch.index) : base;
  const name = rawName.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim() || base;
  return { name, version, slug: base.toLowerCase().replace(/[^a-z0-9]+/g, '-') };
}

async function resolveApksDir() {
  for (const dir of [APKS_DIR, path.join(process.cwd(), 'apks')]) {
    try {
      const st = await fs.stat(dir);
      if (st.isDirectory()) return dir;
    } catch {
      // try next
    }
  }
  return null;
}

async function scanApksFolder(existingReleases = []) {
  const dir = await resolveApksDir();
  if (!dir) return [];

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const apkFiles = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.apk'));
  const scanned = [];

  for (const entry of apkFiles) {
    const filePath = path.join(dir, entry.name);
    const stat = await fs.stat(filePath);
    const buf = await fs.readFile(filePath);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const parsed = parseApkFilename(entry.name);

    let sidecar = {};
    const sidecarPath = path.join(dir, entry.name.replace(/\.apk$/i, '.json'));
    try {
      sidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf-8'));
    } catch {
      // optional sidecar
    }

    const existing = existingReleases.find((r) => r.apkFile === entry.name || r.slug === parsed.slug);
    const downloadUrl = `/apks/${encodeURIComponent(entry.name)}`;

    if (existing) {
      existing.apkFile = entry.name;
      existing.downloadUrl = downloadUrl;
      existing.fileSize = formatBytes(stat.size);
      existing.sha256 = sha256;
      existing.source = 'git-folder';
      continue;
    }

    const checklist = Array.isArray(sidecar.checklist)
      ? sidecar.checklist.map((label, i) => ({
          id: `chk-${parsed.slug}-${i + 1}`,
          label: String(label),
          status: 'pending',
          tester: null
        }))
      : [
          { id: `chk-${parsed.slug}-1`, label: 'Download & install APK on Android device', status: 'pending', tester: null },
          { id: `chk-${parsed.slug}-2`, label: 'Verify cold launch & core user flow', status: 'pending', tester: null }
        ];

    scanned.push({
      id: `apk-${parsed.slug}`,
      name: sidecar.name || parsed.name,
      slug: parsed.slug,
      version: sidecar.version || parsed.version,
      stage: STAGE_ORDER.includes(sidecar.stage) ? sidecar.stage : 'Closed Beta',
      health: sidecar.health || 'Healthy',
      apkFile: entry.name,
      downloadUrl,
      url: downloadUrl,
      fileSize: formatBytes(stat.size),
      sha256,
      source: 'git-folder',
      repoBranch: sidecar.repoBranch || 'main',
      buildHash: sha256.slice(0, 7),
      owner: sidecar.owner || 'DWARAKA Mobile Team',
      summary: sidecar.summary || `Auto-detected Android beta APK (${entry.name}) ready for device download and QA testing.`,
      changelog: Array.isArray(sidecar.changelog) ? sidecar.changelog : [`Uploaded ${entry.name} via Git apks/ folder`],
      tags: Array.isArray(sidecar.tags) ? sidecar.tags : ['android', 'apk', 'mobile-beta'],
      accessLevel: sidecar.accessLevel || 'Beta Team Only',
      checklist,
      createdAt: stat.birthtime?.toISOString?.() || stat.mtime.toISOString(),
      updatedAt: stat.mtime.toISOString()
    });
  }

  return scanned;
}

export async function handleApi(req, res, pathname, dbPath = DEFAULT_DB_PATH) {
  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, service: 'dwaraka-beta-portal', timestamp: new Date().toISOString() });
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      const db = await readDb(dbPath);
      const discovered = await scanApksFolder(db.releases);
      if (discovered.length > 0) {
        db.releases = [...discovered, ...db.releases];
        await writeDb(dbPath, db);
      }
      const { adminPin, ...publicSettings } = db.settings;
      return sendJson(res, 200, {
        settings: publicSettings,
        releases: db.releases,
        feedback: db.feedback,
        team: db.team,
        activity: db.activity
      });
    }

    if (req.method === 'POST' && pathname === '/api/auth/verify-pin') {
      const body = await readJsonBody(req);
      const db = await readDb(dbPath);
      const valid = String(body.pin || '').trim() === db.settings.adminPin;
      return sendJson(res, valid ? 200 : 401, { valid });
    }

    if (req.method === 'POST' && pathname === '/api/auth/verify-invite') {
      const body = await readJsonBody(req);
      const db = await readDb(dbPath);
      const valid = String(body.code || '').trim().toUpperCase() === db.settings.inviteCode.toUpperCase();
      return sendJson(res, valid ? 200 : 401, { valid });
    }

    if (req.method === 'POST' && pathname === '/api/settings/rotate-invite') {
      const db = await readDb(dbPath);
      const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
      db.settings.inviteCode = `DSL-BETA-${suffix}`;
      addActivity(db, 'security', 'Labs Admin', `Rotated beta team invite code to ${db.settings.inviteCode}`);
      await writeDb(dbPath, db);
      return sendJson(res, 200, { inviteCode: db.settings.inviteCode, activity: db.activity[0] });
    }

    if (req.method === 'POST' && pathname === '/api/releases') {
      const body = await readJsonBody(req);
      if (!body.name || !body.version || !body.url) {
        return sendJson(res, 400, { error: 'Name, version, and target URL are required.' });
      }
      const db = await readDb(dbPath);
      const now = new Date().toISOString();
      const slug = (body.slug || body.name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      const checklistItems = Array.isArray(body.checklist)
        ? body.checklist
            .map((c) => (typeof c === 'string' ? c.trim() : c?.label?.trim()))
            .filter(Boolean)
            .map((label) => ({
              id: `chk-${crypto.randomUUID().slice(0, 6)}`,
              label,
              status: 'pending',
              tester: null
            }))
        : [];

      const release = {
        id: `rel-${slug.slice(0, 14)}-${crypto.randomUUID().slice(0, 4)}`,
        name: String(body.name).trim(),
        slug,
        version: String(body.version).trim(),
        stage: STAGE_ORDER.includes(body.stage) ? body.stage : 'Closed Beta',
        health: body.health || 'Healthy',
        url: sanitizeUrl(body.url),
        repoBranch: String(body.repoBranch || 'main').trim(),
        buildHash: String(body.buildHash || crypto.randomBytes(4).toString('hex').slice(0, 7)).trim(),
        owner: String(body.owner || 'Dwaraka Core Team').trim(),
        summary: String(body.summary || 'Early-access beta build for QA verification.').trim(),
        changelog: Array.isArray(body.changelog)
          ? body.changelog.map((item) => String(item).trim()).filter(Boolean)
          : String(body.changelog || '')
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
        tags: Array.isArray(body.tags)
          ? body.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
          : String(body.tags || '')
              .split(',')
              .map((t) => t.trim().toLowerCase())
              .filter(Boolean),
        accessLevel: String(body.accessLevel || 'Beta Team Only').trim(),
        checklist: checklistItems,
        createdAt: now,
        updatedAt: now
      };

      db.releases.unshift(release);
      addActivity(db, 'release', release.owner, `Published ${release.name} ${release.version} (${release.stage})`);
      await writeDb(dbPath, db);
      return sendJson(res, 201, { release, activity: db.activity[0] });
    }

    if (pathname.startsWith('/api/releases/')) {
      const id = decodeURIComponent(pathname.slice('/api/releases/'.length));
      const db = await readDb(dbPath);
      const idx = db.releases.findIndex((r) => r.id === id);
      if (idx === -1) return sendJson(res, 404, { error: 'Release not found.' });

      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        const rel = db.releases[idx];
        const prevStage = rel.stage;
        const prevHealth = rel.health;

        if (body.action === 'promote') {
          const currentIdx = STAGE_ORDER.indexOf(rel.stage);
          if (currentIdx >= 0 && currentIdx < STAGE_ORDER.length - 2) {
            rel.stage = STAGE_ORDER[currentIdx + 1];
            addActivity(db, 'promotion', body.actor || rel.owner, `Promoted ${rel.name} from ${prevStage} to ${rel.stage}`);
          }
        } else if (body.action === 'toggle-pause') {
          rel.health = rel.health === 'Paused' ? 'Healthy' : 'Paused';
          addActivity(
            db,
            'lifecycle',
            body.actor || rel.owner,
            `${rel.health === 'Paused' ? 'Paused' : 'Resumed'} ${rel.name} (${rel.version})`
          );
        } else if (body.action === 'checklist-update' && body.checkId) {
          const chk = rel.checklist.find((c) => c.id === body.checkId);
          if (chk) {
            chk.status = ['pass', 'fail', 'pending'].includes(body.status) ? body.status : chk.status;
            chk.tester = body.tester || 'Beta Tester';
            if (chk.status === 'fail' && rel.health === 'Healthy') {
              rel.health = 'Issues Reported';
            }
            addActivity(
              db,
              'qa',
              chk.tester,
              `Marked "${chk.label.slice(0, 48)}" as ${chk.status.toUpperCase()} on ${rel.name}`
            );
          }
        } else {
          if (body.name !== undefined) rel.name = String(body.name).trim();
          if (body.version !== undefined) rel.version = String(body.version).trim();
          if (body.stage !== undefined && STAGE_ORDER.includes(body.stage)) rel.stage = body.stage;
          if (body.health !== undefined) rel.health = body.health;
          if (body.url !== undefined) rel.url = sanitizeUrl(body.url);
          if (body.summary !== undefined) rel.summary = String(body.summary).trim();
          if (body.accessLevel !== undefined) rel.accessLevel = String(body.accessLevel).trim();
          if (body.repoBranch !== undefined) rel.repoBranch = String(body.repoBranch).trim();
          if (body.buildHash !== undefined) rel.buildHash = String(body.buildHash).trim();
          if (prevStage !== rel.stage) {
            addActivity(db, 'promotion', body.actor || rel.owner, `Updated ${rel.name} stage to ${rel.stage}`);
          } else if (prevHealth !== rel.health) {
            addActivity(db, 'lifecycle', body.actor || rel.owner, `Updated ${rel.name} health to ${rel.health}`);
          } else {
            addActivity(db, 'release', body.actor || rel.owner, `Updated metadata for ${rel.name} ${rel.version}`);
          }
        }

        rel.updatedAt = new Date().toISOString();
        await writeDb(dbPath, db);
        return sendJson(res, 200, { release: rel, activity: db.activity[0] });
      }

      if (req.method === 'DELETE') {
        const [removed] = db.releases.splice(idx, 1);
        addActivity(db, 'lifecycle', 'Labs Admin', `Archived & removed ${removed.name} (${removed.version})`);
        await writeDb(dbPath, db);
        return sendJson(res, 200, { deleted: removed.id, activity: db.activity[0] });
      }
    }

    if (req.method === 'POST' && pathname === '/api/feedback') {
      const body = await readJsonBody(req);
      if (!body.releaseId || !body.title) {
        return sendJson(res, 400, { error: 'Release and issue title are required.' });
      }
      const db = await readDb(dbPath);
      const rel = db.releases.find((r) => r.id === body.releaseId);
      if (!rel) return sendJson(res, 404, { error: 'Target release not found.' });

      const item = {
        id: `fb-${crypto.randomUUID().slice(0, 6)}`,
        releaseId: rel.id,
        releaseName: rel.name,
        releaseVersion: rel.version,
        title: String(body.title).trim(),
        description: String(body.description || '').trim(),
        severity: ['Critical', 'High', 'Medium', 'Low'].includes(body.severity) ? body.severity : 'Medium',
        category: String(body.category || 'Bug').trim(),
        status: 'Open',
        reporter: String(body.reporter || 'Anonymous Tester').trim(),
        environment: String(body.environment || 'Web Browser').trim(),
        leadNote: '',
        createdAt: new Date().toISOString()
      };

      db.feedback.unshift(item);
      if ((item.severity === 'Critical' || item.severity === 'High') && rel.health === 'Healthy') {
        rel.health = 'Issues Reported';
        rel.updatedAt = new Date().toISOString();
      }
      addActivity(db, 'feedback', item.reporter, `Reported ${item.severity} ${item.category} on ${rel.name}: ${item.title}`);
      await writeDb(dbPath, db);
      return sendJson(res, 201, { feedback: item, release: rel, activity: db.activity[0] });
    }

    if (pathname.startsWith('/api/feedback/')) {
      const id = decodeURIComponent(pathname.slice('/api/feedback/'.length));
      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        const db = await readDb(dbPath);
        const item = db.feedback.find((f) => f.id === id);
        if (!item) return sendJson(res, 404, { error: 'Feedback item not found.' });

        if (body.status && ['Open', 'In Review', 'Fixed', "Won't Fix"].includes(body.status)) {
          item.status = body.status;
        }
        if (body.leadNote !== undefined) {
          item.leadNote = String(body.leadNote).trim();
        }
        addActivity(db, 'triage', 'Labs Lead', `Updated feedback "${item.title.slice(0, 40)}" → ${item.status}`);
        await writeDb(dbPath, db);
        return sendJson(res, 200, { feedback: item, activity: db.activity[0] });
      }
    }

    if (req.method === 'POST' && pathname === '/api/team') {
      const body = await readJsonBody(req);
      if (!body.name || !body.email) {
        return sendJson(res, 400, { error: 'Name and email are required.' });
      }
      const db = await readDb(dbPath);
      const member = {
        id: `tm-${crypto.randomUUID().slice(0, 6)}`,
        name: String(body.name).trim(),
        email: String(body.email).trim(),
        role: String(body.role || 'Beta Tester').trim(),
        status: 'Active',
        assigned: Array.isArray(body.assigned) && body.assigned.length > 0 ? body.assigned : ['All Releases'],
        joinedAt: new Date().toISOString().slice(0, 10)
      };
      db.team.unshift(member);
      addActivity(db, 'team', 'Labs Admin', `Added ${member.name} (${member.role}) to beta roster`);
      await writeDb(dbPath, db);
      return sendJson(res, 201, { member, activity: db.activity[0] });
    }

    if (pathname.startsWith('/api/team/')) {
      const id = decodeURIComponent(pathname.slice('/api/team/'.length));
      const db = await readDb(dbPath);
      const idx = db.team.findIndex((m) => m.id === id);
      if (idx === -1) return sendJson(res, 404, { error: 'Team member not found.' });

      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        const member = db.team[idx];
        if (body.status) member.status = body.status;
        if (body.role) member.role = body.role;
        addActivity(db, 'team', 'Labs Admin', `Updated ${member.name} (${member.role} · ${member.status})`);
        await writeDb(dbPath, db);
        return sendJson(res, 200, { member, activity: db.activity[0] });
      }

      if (req.method === 'DELETE') {
        const [removed] = db.team.splice(idx, 1);
        addActivity(db, 'team', 'Labs Admin', `Removed ${removed.name} from beta roster`);
        await writeDb(dbPath, db);
        return sendJson(res, 200, { deleted: removed.id, activity: db.activity[0] });
      }
    }

    return sendJson(res, 404, { error: 'API route not found.' });
  } catch (err) {
    return sendJson(res, 500, { error: err.message || 'Internal server error' });
  }
}

async function serveStatic(res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const candidateDirs = [PUBLIC_DIR, path.join(process.cwd(), 'public')];

  for (const baseDir of candidateDirs) {
    const resolved = path.resolve(baseDir, `.${safePath}`);
    if (!resolved.startsWith(baseDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    try {
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) {
        return serveStatic(res, path.join(safePath, 'index.html'));
      }
      const ext = path.extname(resolved).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const content = await fs.readFile(resolved);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
      return;
    } catch {
      // try next baseDir
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

async function serveApk(res, pathname) {
  const dir = await resolveApksDir();
  if (!dir) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('APKs folder not found');
    return;
  }
  const filename = decodeURIComponent(pathname.slice('/apks/'.length));
  const resolved = path.resolve(dir, filename);
  if (!resolved.startsWith(dir) || !filename.toLowerCase().endsWith('.apk')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  try {
    const stat = await fs.stat(resolved);
    const content = await fs.readFile(resolved);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': `attachment; filename="${path.basename(resolved)}"`,
      'Content-Length': stat.size
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('APK Not Found');
  }
}

export function createHandler(dbPath = DEFAULT_DB_PATH) {
  return (req, res) => {
    const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;

    if (pathname.startsWith('/api/')) {
      return handleApi(req, res, pathname, dbPath);
    }
    if (pathname.startsWith('/apks/')) {
      return serveApk(res, pathname);
    }
    return serveStatic(res, pathname);
  };
}

export function createServer(dbPath = DEFAULT_DB_PATH) {
  return http.createServer(createHandler(dbPath));
}

export default createHandler(DEFAULT_DB_PATH);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const server = createServer(DEFAULT_DB_PATH);
  server.listen(port, () => {
    console.log(`DWARAKA Software Labs — Beta Portal running at http://localhost:${port}`);
  });
}
