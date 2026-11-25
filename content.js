/* TRN Match Finder — scans a tracker.gg Valorant profile's match history for
   games shared with a target player. Uses the same internal TRN API the site
   itself consumes, so no scraping and no auth. */
(() => {
  if (window.__trnmf) return;
  window.__trnmf = true;

  const API = 'https://api.tracker.gg/api/v2/valorant/standard';
  const CONCURRENCY = 2;

  // ---------- helpers ----------

  function ownerFromUrl() {
    const m = location.pathname.match(/\/valorant\/profile\/([^/]+)\/([^/]+)/);
    if (!m) return null;
    return decodeURIComponent(m[2]); // e.g. "pleasedontlack#fyb"
  }

  function normIgn(ign) {
    return ign.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function fetchJson(url, retries = 5) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      let res;
      try {
        res = await fetch(url, { headers: { accept: 'application/json' } });
      } catch (e) {
        if (attempt === retries) throw new Error(`network error: ${e.message}`);
        await sleep(800 * (attempt + 1));
        continue;
      }
      if (res.ok) return res.json();
      if (res.status === 429) {
        // TRN's Warden anti-bot wall looks like a plain 429 but demands a
        // captcha — the scanner must treat it as a cooldown, not a retry.
        const body = await res.text().catch(() => '');
        if (body.includes('Warden::Challenge')) {
          const err = new Error('TRN captcha wall (Warden)');
          err.warden = true;
          throw err;
        }
        if (attempt < retries) {
          await sleep(2500 * (attempt + 1));
          continue;
        }
        throw new Error(`API 429 for ${url}`);
      }
      if (res.status >= 500 && attempt < retries) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      throw new Error(`API ${res.status} for ${url}`);
    }
    throw new Error('unreachable');
  }

  // Map of lowercase handle -> { handle, teamId, agentName, won }
  function extractRoster(data) {
    const players = new Map();
    for (const seg of data.segments || []) {
      const handle = seg.attributes?.platformUserIdentifier;
      if (!handle) continue;
      const key = normIgn(handle);
      const cur = players.get(key) || { handle, teamId: null, agentName: null, won: null };
      if (!cur.teamId && seg.metadata?.teamId) cur.teamId = seg.metadata.teamId;
      if (cur.won === null && typeof seg.metadata?.hasWon === 'boolean') cur.won = seg.metadata.hasWon;
      if (seg.type === 'player-summary') {
        cur.agentName = seg.metadata?.agentName ?? cur.agentName;
      }
      players.set(key, cur);
    }
    return players;
  }

  // ---------- scan cache ----------
  // Matches already checked are never re-fetched: repeat scans and deeper
  // re-scans cost almost zero requests, which is what keeps Warden happy.

  function cacheKey(owner, playlist) { return `trnmf-cache:${normIgn(owner)}:${playlist}`; }

  function loadCache(owner, playlist) {
    try {
      const c = JSON.parse(localStorage.getItem(cacheKey(owner, playlist)) || '{}');
      return {
        checked: Array.isArray(c.checked) ? c.checked : [],
        hits: Array.isArray(c.hits) ? c.hits : [],
      };
    } catch { return { checked: [], hits: [] }; }
  }

  function saveCache(owner, playlist, checked, hits) {
    try {
      localStorage.setItem(cacheKey(owner, playlist),
        JSON.stringify({ checked: checked.slice(-1200), hits: hits.slice(0, 50) }));
    } catch { /* quota or privacy mode — cache is a bonus, not a requirement */ }
  }

  function mergeHits(scanHits, cachedHits) {
    const out = [];
    const ids = new Set();
    for (const h of [...scanHits, ...cachedHits]) {
      if (ids.has(h.id)) continue;
      ids.add(h.id);
      out.push(h);
    }
    return out;
  }

  // ---------- scan core ----------

  async function scan(owner, targetRaw, opts, onProgress) {
    const target = normIgn(targetRaw);
    const playlist = opts.playlist === 'all' ? '' : `&type=${opts.playlist}`;
    const base = `${API}/matches/riot/${encodeURIComponent(owner)}?platform=pc&season=${encodeURIComponent(opts.season || '')}${playlist}`;

    const cache = loadCache(owner, opts.playlist);
    const preChecked = new Set(cache.checked);
    const cachedHitIds = new Set(cache.hits.map(h => h.id));

    const hits = [];
    const seen = new Set();
    let next = 0;
    let pages = 0;
    let scanned = 0;
    let skipped = 0;
    let cached = 0;
    let cooldowns = 0;
    let aborted = false;
    let stopEarly = false;
    const shouldStop = () => opts.abortFlag.aborted;

    // AIMD pacing: the gap between chunks shrinks while responses are clean
    // and doubles on any throttle signal, riding just under TRN's limit.
    let gap = 250;

    while (next !== null && pages < opts.maxPages && !stopEarly) {
      if (shouldStop()) { aborted = true; break; }
      const list = await fetchJson(`${base}&next=${next}`);
      const matches = list?.data?.matches;
      if (!matches || matches.length === 0) break;
      pages++;

      for (let i = 0; i < matches.length && !shouldStop() && !stopEarly; i += CONCURRENCY) {
        const chunk = matches.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(chunk.map(async m => {
          const id = m.attributes.id;
          if (seen.has(id)) return null;
          seen.add(id);
          if (preChecked.has(id)) { cached++; return { m, cached: true }; }
          const detail = await fetchJson(`${API}/matches/${id}`);
          return { m, roster: extractRoster(detail.data) };
        }));

        let wardenHit = false;
        let throttled = 0;
        const results = [];
        for (const s of settled) {
          if (s.status === 'fulfilled') { results.push(s.value); continue; }
          if (s.reason?.warden) wardenHit = true;
          else { throttled++; skipped++; }
        }

        scanned += chunk.length;

        if (wardenHit) {
          cooldowns++;
          if (cooldowns > 3) {
            throw new Error('TRN captcha wall keeps re-triggering — wait a few minutes and scan again. Already-checked matches are cached and will not be re-fetched.');
          }
          onProgress?.(scanned, pages, skipped, cached, 'cooldown');
          // retry the same chunk after cooling down; ids already fetched
          // short-circuit through `seen`, so the retry costs nothing extra
          i -= CONCURRENCY;
          gap = Math.min(4000, gap * 2);
          await sleep(45000 * cooldowns);
          continue;
        }

        gap = throttled ? Math.min(4000, gap * 2) : Math.max(150, Math.round(gap * 0.85));
        onProgress?.(scanned, pages, skipped, cached, 'ok');

        for (const r of results) {
          if (!r) continue;
          if (r.cached) {
            // a known hit on this page satisfies first-hit mode — the card
            // comes back through mergeHits, so just stop fetching here
            if (opts.firstHitOnly && cachedHitIds.has(r.m.attributes.id)) stopEarly = true;
            continue;
          }
          const t = r.roster.get(target);
          if (!t) continue;
          const o = r.roster.get(normIgn(owner));
          const sameTeam = o?.teamId && t.teamId ? o.teamId === t.teamId : null;
          hits.push({
            id: r.m.attributes.id,
            map: r.m.metadata?.mapName ?? 'Unknown',
            timestamp: r.m.metadata?.timestamp ?? null,
            mode: r.m.metadata?.modeName ?? '',
            relation: sameTeam === null ? 'same match' : sameTeam ? 'teammate' : 'opponent',
            targetWon: t.won,
            targetAgent: t.agentName,
            ownerAgent: o?.agentName ?? null,
          });
          if (opts.firstHitOnly) stopEarly = true;
        }
        await sleep(gap);
      }

      next = list.data.metadata?.next ?? null;
      if (typeof next !== 'number') next = null;
    }

    const allHits = mergeHits(hits, cache.hits);
    saveCache(owner, opts.playlist, [...preChecked, ...seen], allHits);

    return { hits: allHits, scanned, pages, skipped, cached, aborted, exhausted: next === null, cooldowns };
  }

  // ---------- UI ----------

  const toggle = document.createElement('button');
  toggle.id = 'trnmf-toggle';
  toggle.textContent = 'MATCH FINDER';

  const panel = document.createElement('div');
  panel.id = 'trnmf-panel';
  panel.innerHTML = `
    <div class="trnmf-head">
      <span>MATCH FINDER</span>
      <button class="trnmf-close" title="Close">✕</button>
    </div>
    <div class="trnmf-body">
      <div class="trnmf-row">
        <span class="trnmf-label">Profile being scanned</span>
        <div class="trnmf-owner"></div>
      </div>
      <div class="trnmf-row">
        <label class="trnmf-label" for="trnmf-target">Find player (name#tag)</label>
        <input id="trnmf-target" type="text" placeholder="kitten dad#aiden" spellcheck="false">
      </div>
      <div class="trnmf-row trnmf-duo">
        <div>
          <label class="trnmf-label" for="trnmf-playlist">Playlist</label>
          <select id="trnmf-playlist">
            <option value="competitive" selected>Competitive</option>
            <option value="premier">Premier</option>
            <option value="unrated">Unrated</option>
            <option value="deathmatch">Deathmatch</option>
            <option value="all">All</option>
          </select>
        </div>
        <div>
          <label class="trnmf-label" for="trnmf-pages">Max pages (20/pg)</label>
          <input id="trnmf-pages" type="number" min="1" max="60" value="15">
        </div>
      </div>
      <div class="trnmf-row trnmf-checkrow">
        <label class="trnmf-check" for="trnmf-firsthit">
          <input id="trnmf-firsthit" type="checkbox" checked>
          <span>Stop at first hit — fastest for refund lookups</span>
        </label>
      </div>
      <div class="trnmf-actions">
        <button id="trnmf-scan">Scan</button>
        <button id="trnmf-cancel">Cancel</button>
      </div>
      <div class="trnmf-progress-wrap">
        <div class="trnmf-ring">
          <svg class="trnmf-ring-svg" viewBox="0 0 48 48" aria-hidden="true">
            <circle class="trnmf-ring-track" cx="24" cy="24" r="20"></circle>
            <circle class="trnmf-ring-arc" cx="24" cy="24" r="20" transform="rotate(-90 24 24)"></circle>
          </svg>
          <svg class="trnmf-ring-spin" viewBox="0 0 48 48" aria-hidden="true">
            <circle cx="24" cy="24" r="20"></circle>
          </svg>
        </div>
        <div class="trnmf-progress-count"></div>
      </div>
      <div class="trnmf-progress"></div>
      <div class="trnmf-results"></div>
    </div>`;

  document.body.appendChild(toggle);
  document.body.appendChild(panel);

  const el = {
    owner: panel.querySelector('.trnmf-owner'),
    target: panel.querySelector('#trnmf-target'),
    playlist: panel.querySelector('#trnmf-playlist'),
    pages: panel.querySelector('#trnmf-pages'),
    scan: panel.querySelector('#trnmf-scan'),
    cancel: panel.querySelector('#trnmf-cancel'),
    firstHit: panel.querySelector('#trnmf-firsthit'),
    progressWrap: panel.querySelector('.trnmf-progress-wrap'),
    ringArc: panel.querySelector('.trnmf-ring-arc'),
    progressCount: panel.querySelector('.trnmf-progress-count'),
    progress: panel.querySelector('.trnmf-progress'),
    results: panel.querySelector('.trnmf-results'),
  };

  toggle.addEventListener('click', () => panel.classList.toggle('trnmf-open'));
  panel.querySelector('.trnmf-close').addEventListener('click', () => panel.classList.remove('trnmf-open'));

  el.target.value = localStorage.getItem('trnmf-target') || '';

  // tracker.gg is a SPA: owner changes without a reload, so poll cheaply.
  let currentOwner = ownerFromUrl();
  el.owner.textContent = currentOwner ?? 'not on a profile page';
  setInterval(() => {
    const o = ownerFromUrl();
    if (o !== currentOwner) {
      currentOwner = o;
      el.owner.textContent = o ?? 'not on a profile page';
    }
  }, 1000);

  const abortFlag = { aborted: false };

  // Progress ring: circumference of the r=20 arc circle in the 48px viewBox.
  // Fraction is pages scanned / maxPages; the arc sweeps from 12 o'clock.
  const RING_LEN = 2 * Math.PI * 20;
  function setProgress(fraction) {
    const f = Math.max(0, Math.min(1, fraction));
    el.ringArc.style.strokeDashoffset = (RING_LEN * (1 - f)).toFixed(2);
  }

  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function renderDone({ hits, scanned, pages, skipped, cached, aborted, exhausted }) {
    el.progressWrap.classList.remove('trnmf-scanning');
    el.progress.textContent =
      `${scanned} matches scanned over ${pages} page${pages === 1 ? '' : 's'}` +
      (cached ? ` (${cached} served from cache)` : '') +
      (skipped ? ` (${skipped} unreadable — throttled)` : '') +
      (aborted ? ' — cancelled' : exhausted ? ' — full history' : ' — done');
    el.results.innerHTML = '';
    if (hits.length === 0) {
      const div = document.createElement('div');
      div.className = 'trnmf-empty';
      div.textContent = 'No shared matches found in scanned range.';
      el.results.appendChild(div);
      return;
    }
    if (hits.length === 1 && !aborted) {
      el.progress.textContent += ' — opening match…';
      try {
        chrome.runtime.sendMessage({ type: 'trnmf-open', url: `https://tracker.gg/valorant/match/${hits[0].id}` });
      } catch { /* extension context gone — the card link still works */ }
    }
    for (const h of hits) {
      const url = `https://tracker.gg/valorant/match/${h.id}`;
      const card = document.createElement('div');
      card.className = 'trnmf-hit';

      const top = document.createElement('div');
      top.className = 'trnmf-hit-top';
      const map = document.createElement('span');
      map.className = 'trnmf-hit-map';
      map.textContent = h.map;
      const badge = document.createElement('span');
      badge.className = `trnmf-badge trnmf-badge-trnmf-${h.relation === 'teammate' ? 'teammate' : 'opponent'}`;
      badge.textContent = h.relation;
      top.append(map, badge);

      const sub = document.createElement('div');
      sub.className = 'trnmf-hit-sub';
      const bits = [fmtDate(h.timestamp), h.mode];
      if (h.targetAgent) bits.push(`${h.targetAgent} (them)`);
      if (h.ownerAgent) bits.push(`${h.ownerAgent} (owner)`);
      if (h.targetWon !== null && h.targetWon !== undefined) bits.push(h.targetWon ? 'they won' : 'they lost');
      sub.textContent = bits.filter(Boolean).join(' · ');

      const links = document.createElement('div');
      links.className = 'trnmf-hit-links';
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'open match ↗';
      const copy = document.createElement('button');
      copy.className = 'trnmf-copy';
      copy.textContent = 'copy link';
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(url).then(() => { copy.textContent = 'copied'; });
      });
      links.append(a, copy);

      card.append(top, sub, links);
      el.results.appendChild(card);
    }
  }

  async function runScan() {
    const owner = currentOwner;
    const target = el.target.value;
    if (!owner) { el.progress.textContent = 'Open a Valorant profile first.'; return; }
    if (!target.includes('#')) { el.progress.textContent = 'Target needs name#tag.'; return; }

    const maxPages = Math.max(1, Math.min(60, parseInt(el.pages.value, 10) || 15));

    localStorage.setItem('trnmf-target', target);
    abortFlag.aborted = false;
    el.scan.disabled = true;
    el.cancel.classList.add('trnmf-visible');
    el.results.innerHTML = '';
    el.progress.textContent = 'starting…';
    el.progressCount.textContent = `0 / ${maxPages * 20} matches`;
    setProgress(0);
    el.progressWrap.classList.add('trnmf-scanning');

    try {
      const result = await scan(owner, target, {
        playlist: el.playlist.value,
        season: '',
        maxPages,
        abortFlag,
        firstHitOnly: el.firstHit.checked,
      }, (scanned, pages, skipped, cached, phase) => {
        setProgress(pages / maxPages);
        el.progressCount.textContent = `${scanned} / ${maxPages * 20} matches`;
        if (phase === 'cooldown') {
          el.progress.textContent = 'captcha wall hit — cooling down, scan resumes automatically…';
        } else {
          el.progress.textContent = `page ${pages} of ${maxPages}` +
            (skipped ? ` — ${skipped} throttled` : '') +
            (cached ? ` — ${cached} cached` : '') + '…';
        }
      });
      renderDone(result);
    } catch (e) {
      el.progressWrap.classList.remove('trnmf-scanning');
      el.progress.textContent = '';
      el.results.innerHTML = '';
      const div = document.createElement('div');
      div.className = 'trnmf-error';
      div.textContent = `scan failed: ${e.message}`;
      el.results.appendChild(div);
    } finally {
      el.scan.disabled = false;
      el.cancel.classList.remove('trnmf-visible');
    }
  }

  el.scan.addEventListener('click', runScan);
  el.cancel.addEventListener('click', () => { abortFlag.aborted = true; });

  // exposed for testing
  window.__trnmfScan = scan;
})();
