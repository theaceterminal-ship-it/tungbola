/* ═══════════════════════════════════════════════════════════════════════════
   TUNGBOLA UNIVERSAL SHEET PARSER  ·  v2
   ───────────────────────────────────────────────────────────────────────────
   Drop-in replacement for pdfToText() + parseText().

   Reads TOKEN BOXES (x/y/width/height), not lines of text. One engine serves
   every input type:

       vector PDF  ──▶ pdf.js text items ──┐
       scanned PDF ──▶ render ▸ OCR boxes ─┼──▶ geometry engine ──▶ tickets
       JPG / PNG   ──▶ OCR word boxes ─────┘
       JSON        ──▶ passthrough

   It never looks for brand names ("Good Luck", "King of Ring", "TUKPA"…),
   never assumes a line order, and never assumes a vendor layout. Structure is
   recovered from geometry and then checked against the invariants every
   tambola sheet obeys:

       · a ticket  = 3 rows x 5 numbers = 15 numbers
       · column c  = 1-9, 10-19, 20-29 … 80-90
       · a column of a ticket holds 1..3 numbers
       · a 6-ticket sheet holds each of 1..90 exactly once

   Those invariants are also used to REPAIR numbers OCR dropped — but only
   when the answer is provably unique. It never guesses a number.

   USAGE (replaces the old per-file try/catch body):

       const sheets = await TBFiles.parseFile(file);      // any file type

   Optional OCR config (only needed for scanned PDFs / images):

       TBFiles.config({ ocrApiKey: 'YOUR_OCRSPACE_KEY' });

   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  /* ── small utils ─────────────────────────────────────────────────────── */
  function med(a) {
    if (!a.length) return 0;
    var s = a.slice().sort(function (x, y) { return x - y; }), n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
  function n2col(n) {
    if (n >= 1 && n <= 9) return 0;
    if (n >= 10 && n <= 19) return 1;
    if (n >= 20 && n <= 29) return 2;
    if (n >= 30 && n <= 39) return 3;
    if (n >= 40 && n <= 49) return 4;
    if (n >= 50 && n <= 59) return 5;
    if (n >= 60 && n <= 69) return 6;
    if (n >= 70 && n <= 79) return 7;
    if (n >= 80 && n <= 90) return 8;
    return -1;
  }
  function dist1d(v, lo, hi) { return v < lo ? lo - v : v > hi ? v - hi : 0; }
  function normLig(s) {
    return String(s).replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi')
      .replace(/ﬂ/g, 'fl').replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
      .replace(/ /g, ' ');
  }

  /* ── 1. TOKENISE ─────────────────────────────────────────────────────────
     input  raw item: {str, x, y, w, h}   x,y = LEFT/TOP, y grows DOWNWARD
     output token   : {t, x0,x1,y0,y1, cx,cy, w,h}
     Multi-word items (some producers emit a whole row as one item) are split
     into sub-tokens with x interpolated across the item box.               */
  function tokenize(raw) {
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var it = raw[i];
      var s = normLig(it.str == null ? '' : it.str);
      if (!s.trim()) continue;
      var w = it.w || 0, h = it.h || 0;
      var parts = [], re = /\S+/g, m;
      while ((m = re.exec(s))) parts.push({ t: m[0], i: m.index });
      if (!parts.length) continue;
      if (parts.length === 1 || !w) {
        out.push({ t: parts.length === 1 ? parts[0].t : s.trim(), x0: it.x, x1: it.x + w, y0: it.y, y1: it.y + h });
      } else {
        var len = s.length || 1;
        for (var p = 0; p < parts.length; p++) {
          var a = parts[p].i / len, b = (parts[p].i + parts[p].t.length) / len;
          out.push({ t: parts[p].t, x0: it.x + a * w, x1: it.x + b * w, y0: it.y, y1: it.y + h, est: true });
        }
      }
    }
    for (var k = 0; k < out.length; k++) {
      var o = out[k];
      o.cx = (o.x0 + o.x1) / 2; o.cy = (o.y0 + o.y1) / 2;
      o.w = o.x1 - o.x0; o.h = o.y1 - o.y0;
      if (!(o.h > 0)) { o.h = 10; o.y1 = o.y0 + 10; o.cy = o.y0 + 5; }
      if (!(o.w > 0)) { o.w = 6; o.x1 = o.x0 + 6; o.cx = o.x0 + 3; }
    }
    return out;
  }

  /* ── 2. NUMBER CANDIDATES ────────────────────────────────────────────── */
  function numValue(t) {
    var s = t.replace(/[^\d]/g, '');
    if (!s || s.length > 2) return null;         // >2 digits handled by merge-split
    var v = parseInt(s, 10);
    return v >= 1 && v <= 90 ? v : null;
  }
  function splitMerged(str) {                    // "2143" -> [21,43]
    var s = str.replace(/[^\d]/g, '');
    if (s.length < 2 || s.length > 4) return null;
    var best = null;
    for (var i = 1; i < s.length; i++) {
      var a = parseInt(s.slice(0, i), 10), b = parseInt(s.slice(i), 10);
      if (s[i] === '0' && s.slice(i).length > 1 && b < 10) continue;
      if (a >= 1 && a <= 90 && b >= 1 && b <= 90) {
        if (!best || Math.abs(i - s.length / 2) < best.d) best = { p: [a, b], d: Math.abs(i - s.length / 2), i: i };
      }
    }
    return best ? best.p : null;
  }

  /* ── 3. COLUMN GRID GATE ─────────────────────────────────────────────────
     Numbers on a real ticket sit on a regular x-grid. Watermarks, sheet
     labels, page numbers and footers do not. Build the grid from confident
     tokens and reject anything off it.                                     */
  function buildXGrid(nums) {
    if (nums.length < 10) return null;
    var xs = nums.map(function (n) { return n.cx; }).sort(function (a, b) { return a - b; });
    var mw = med(nums.map(function (n) { return n.w; })) || 10;
    var tol = Math.max(mw * 0.75, 4);
    var cols = [], cur = [xs[0]];
    for (var i = 1; i < xs.length; i++) {
      if (xs[i] - cur[cur.length - 1] <= tol) cur.push(xs[i]);
      else { cols.push(cur); cur = [xs[i]]; }
    }
    cols.push(cur);
    var strong = cols.filter(function (c) { return c.length >= 2; });
    if (strong.length < 5) return null;          // grid too weak to trust
    var centers = strong.map(function (c) { return med(c); });
    var pitch = centers.length > 1 ? med(centers.slice(1).map(function (v, i) { return v - centers[i]; })) : mw * 2;
    return { centers: centers, tol: Math.max(pitch * 0.45, mw * 0.9, 5) };
  }
  function onGrid(grid, x) {
    if (!grid) return true;
    for (var i = 0; i < grid.centers.length; i++)
      if (Math.abs(grid.centers[i] - x) <= grid.tol) return true;
    return false;
  }

  /* ── 4. ROW BANDS ────────────────────────────────────────────────────── */
  function bandRows(nums) {
    var sorted = nums.slice().sort(function (a, b) { return a.cy - b.cy; });
    var h = med(nums.map(function (n) { return n.h; })) || 10;
    var tol = Math.max(h * 0.5, 2.5);
    var bands = [], cur = [sorted[0]], ref = sorted[0].cy;
    for (var i = 1; i < sorted.length; i++) {
      if (Math.abs(sorted[i].cy - ref) <= tol) { cur.push(sorted[i]); ref = med(cur.map(function (n) { return n.cy; })); }
      else { bands.push(cur); cur = [sorted[i]]; ref = sorted[i].cy; }
    }
    bands.push(cur);
    return bands.map(function (b) {
      b.sort(function (p, q) { return p.cx - q.cx; });
      return { items: b, cy: med(b.map(function (n) { return n.cy; })) };
    });
  }

  /* ── 5. GROUP BANDS INTO TICKET BLOCKS ───────────────────────────────── */
  function groupBands(bands) {
    if (bands.length <= 3) return [bands];
    var gaps = [];
    for (var i = 1; i < bands.length; i++) gaps.push(bands[i].cy - bands[i - 1].cy);
    var mg = med(gaps) || 1;
    var groups = [], cur = [bands[0]];
    for (var j = 1; j < bands.length; j++) {
      if (gaps[j - 1] > mg * 1.45) { groups.push(cur); cur = [bands[j]]; }
      else cur.push(bands[j]);
    }
    groups.push(cur);
    // any group that isn't a clean multiple of 3 rows -> re-chunk by 3
    var out = [];
    for (var g = 0; g < groups.length; g++) {
      if (groups[g].length === 3) { out.push(groups[g]); continue; }
      for (var s = 0; s < groups[g].length; s += 3) out.push(groups[g].slice(s, s + 3));
    }
    return out;
  }

  /* ── 6. SPLIT A ROW INTO k SIDE-BY-SIDE TICKET SEGMENTS ──────────────── */
  function splitSegments(items, k) {
    if (k <= 1 || items.length < 2) return [items];
    var gaps = [];
    for (var i = 1; i < items.length; i++) gaps.push({ i: i, g: items[i].x0 - items[i - 1].x1 });
    gaps.sort(function (a, b) { return b.g - a.g; });
    var cuts = gaps.slice(0, k - 1).map(function (x) { return x.i; }).sort(function (a, b) { return a - b; });
    var segs = [], start = 0;
    for (var c = 0; c < cuts.length; c++) { segs.push(items.slice(start, cuts[c])); start = cuts[c]; }
    segs.push(items.slice(start));
    return segs;
  }

  /* ── 7. PLACE NUMBERS INTO THE 3x9 GRID ──────────────────────────────── */
  function placeTicket(rowSegs, colX) {
    var numbers = new Array(27).fill(null), issues = [], seen = {};
    for (var ri = 0; ri < Math.min(3, rowSegs.length); ri++) {
      var row = rowSegs[ri] || [];
      for (var i = 0; i < row.length; i++) {
        var it = row[i], v = it.v, col = n2col(v);
        if (col < 0) { issues.push('range:' + v); continue; }
        var idx = ri * 9 + col;
        if (numbers[idx] === null) { numbers[idx] = v; seen[v] = (seen[v] || 0) + 1; }
        else {
          // two numbers claim one cell -> keep the one nearest that column's x
          var prev = numbers[idx], want = colX && colX[col];
          if (want != null) {
            var prevIt = row.find(function (r) { return r.v === prev; });
            var dPrev = prevIt ? Math.abs(prevIt.cx - want) : 1e9;
            var dCur = Math.abs(it.cx - want);
            if (dCur < dPrev) { numbers[idx] = v; issues.push('collide:' + prev); }
            else issues.push('collide:' + v);
          } else issues.push('collide:' + v);
        }
      }
    }
    return { numbers: numbers, issues: issues };
  }

  /* ── 8. SHEET LABEL ("Sheet No. 200", rotated or not) ────────────────── */
  var LABEL_WORD = /^(sheet|sheets|sr|serial|slip|book)$/i;   // NOT "page" — that's a footer
  var LABEL_NOISE = /^(no|nos|num|number|#|:|\.|-)\.?$/i;

  function findSheetLabels(tokens, consumed) {
    var free = tokens.filter(function (t) { return !consumed.has(t); });
    var anchors = free.filter(function (t) { return LABEL_WORD.test(t.t.replace(/[^A-Za-z]/g, '')); });
    var labels = [];
    for (var a = 0; a < anchors.length; a++) {
      var anchor = anchors[a], cluster = [anchor], added = true;
      var reach = Math.min(Math.max(anchor.w, anchor.h), Math.max(anchor.w, anchor.h) * 1.4);
      while (added && cluster.length < 8) {
        added = false;
        for (var i = 0; i < free.length; i++) {
          var t = free[i];
          if (cluster.indexOf(t) >= 0) continue;
          for (var c = 0; c < cluster.length; c++) {
            var m = cluster[c];
            var dy = dist1d(t.cy, m.y0, m.y1), dx = dist1d(t.cx, m.x0, m.x1);
            var oX = Math.min(t.x1, m.x1) - Math.max(t.x0, m.x0);
            var oY = Math.min(t.y1, m.y1) - Math.max(t.y0, m.y0);
            if ((dy <= reach && oX > Math.min(t.w, m.w) * 0.35) ||
                (dx <= reach && oY > Math.min(t.h, m.h) * 0.35)) { cluster.push(t); added = true; break; }
          }
        }
      }
      var vals = cluster.filter(function (t) {
        var s = t.t.replace(/[^\w\-\/]/g, '');
        return s && !LABEL_WORD.test(s) && !LABEL_NOISE.test(s) && /\w/.test(s);
      });
      // prefer a token containing a digit
      vals.sort(function (p, q) { return (/\d/.test(q.t) ? 1 : 0) - (/\d/.test(p.t) ? 1 : 0); });
      if (vals.length) {
        var anchorWord = anchor.t.replace(/[^A-Za-z]/g, '').toLowerCase();
        labels.push({
          name: vals[0].t.replace(/[^\w\-\/]/g, ''),
          score: (anchorWord.indexOf('sheet') === 0 ? 3 : 1) +
                 (cluster.some(function (t) { return LABEL_NOISE.test(t.t.replace(/[^\w#:.\-]/g, '')); }) ? 2 : 0) +
                 (/^\d+$/.test(vals[0].t.replace(/[^\w]/g, '')) ? 1 : 0),
          cy: med(cluster.map(function (t) { return t.cy; })),
          cx: med(cluster.map(function (t) { return t.cx; })),
          tokens: cluster.slice()
        });
      }
    }
    // a page holds 6 tickets per sheet; only trust multiple labels when the
    // count actually matches, otherwise the extras are footers/headers
    return labels;
  }

  /* ── 9. TICKET IDs ───────────────────────────────────────────────────── */
  var ID_RE = /^[A-Za-z#]{0,4}[-]?\d{1,6}[A-Za-z]{0,3}$/;
  function assignIds(blocks, tokens, consumed, rowPitch) {
    var pool = tokens.filter(function (t) {
      if (consumed.has(t)) return false;
      var s = t.t.replace(/[.,:;()\[\]]/g, '');
      return /\d/.test(s) && ID_RE.test(s);
    });
    // a text repeated across most blocks is branding, not an id
    var freq = {};
    pool.forEach(function (t) { var s = t.t.replace(/[.,:;()\[\]]/g, ''); freq[s] = (freq[s] || 0) + 1; });
    if (blocks.length >= 3) pool = pool.filter(function (t) {
      return freq[t.t.replace(/[.,:;()\[\]]/g, '')] < Math.max(2, blocks.length * 0.5);
    });

    var pairs = [];
    for (var b = 0; b < blocks.length; b++) {
      var B = blocks[b].box;
      for (var p = 0; p < pool.length; p++) {
        var t = pool[p];
        var dy = dist1d(t.cy, B.y0, B.y1), dx = dist1d(t.cx, B.x0, B.x1);
        if (dy > rowPitch * 1.35) continue;
        if (dx > (B.x1 - B.x0) * 0.55) continue;
        pairs.push({ b: b, t: t, score: dy * 2 + dx * 0.5 });
      }
    }
    pairs.sort(function (a, c) { return a.score - c.score; });
    var takenB = {}, takenT = new Set();
    for (var i = 0; i < pairs.length; i++) {
      if (takenB[pairs[i].b] || takenT.has(pairs[i].t)) continue;
      takenB[pairs[i].b] = pairs[i].t;
      takenT.add(pairs[i].t);
      consumed.add(pairs[i].t);
    }
    return takenB;
  }

  /* ── 10. INVARIANT REPAIR ────────────────────────────────────────────────
     A complete sheet contains 1..90 exactly once. If a ticket has holes and
     the sheet is missing exactly the numbers that fit those holes, fill them
     in deterministically. Rescues bad OCR without guessing.                */
  function sortColumns(tickets) {                 // tambola: columns ascend downward
    tickets.forEach(function (t) {
      for (var c = 0; c < 9; c++) {
        var vals = [], rows = [];
        for (var r = 0; r < 3; r++) if (t.numbers[r * 9 + c] !== null) { vals.push(t.numbers[r * 9 + c]); rows.push(r); }
        vals.sort(function (a, b) { return a - b; });
        for (var k = 0; k < rows.length; k++) t.numbers[rows[k] * 9 + c] = vals[k];
      }
    });
  }

  /* Constraint solver. Every number 1..90 appears once on a 6-ticket sheet,
     every row holds exactly 5, every column of a ticket holds 1..3. Given the
     numbers OCR dropped, enumerate every legal way to put them back. Apply the
     answer only when it is provably unique — never guess.                   */
  function repairSheet(sheet) {
    var tickets = sheet.tickets;
    if (tickets.length !== 6) { sortColumns(tickets); return 0; }
    var present = {}, dup = false;
    tickets.forEach(function (t) {
      t.numbers.forEach(function (n) { if (n) { if (present[n]) dup = true; present[n] = 1; } });
    });
    if (dup) { sortColumns(tickets); return 0; }
    var missing = [];
    for (var n = 1; n <= 90; n++) if (!present[n]) missing.push(n);
    if (!missing.length) { sortColumns(tickets); return 0; }
    if (missing.length > 12) { sortColumns(tickets); return 0; }

    // current occupancy
    var rowFree = [], colCount = [], rowColUsed = [];
    for (var ti = 0; ti < 6; ti++) {
      var t = tickets[ti], rc = [0, 0, 0], cc = [], used = [];
      for (var c = 0; c < 9; c++) cc.push(0);
      for (var r = 0; r < 3; r++) { used.push({}); }
      for (var i = 0; i < 27; i++) {
        if (t.numbers[i] === null) continue;
        var rr = Math.floor(i / 9), cd = i % 9;
        rc[rr]++; cc[cd]++; used[rr][cd] = 1;
      }
      rowFree.push([5 - rc[0], 5 - rc[1], 5 - rc[2]]);
      colCount.push(cc); rowColUsed.push(used);
    }
    var deficit = 0;
    for (var a = 0; a < 6; a++) for (var b = 0; b < 3; b++) { if (rowFree[a][b] < 0) { sortColumns(tickets); return 0; } deficit += rowFree[a][b]; }
    if (deficit !== missing.length) { sortColumns(tickets); return 0; }

    var CAP = 400, solutions = [], nodes = 0;
    function solve(k, acc) {
      if (solutions.length >= CAP || nodes++ > 300000) return;
      if (k === missing.length) { solutions.push(acc.slice()); return; }
      var v = missing[k], col = n2col(v);
      if (col < 0) return;
      for (var ti2 = 0; ti2 < 6; ti2++) {
        if (colCount[ti2][col] >= 3) continue;
        for (var r2 = 0; r2 < 3; r2++) {
          if (rowFree[ti2][r2] <= 0) continue;
          if (rowColUsed[ti2][r2][col]) continue;
          rowFree[ti2][r2]--; colCount[ti2][col]++; rowColUsed[ti2][r2][col] = 1;
          acc.push({ v: v, ti: ti2, r: r2, c: col });
          solve(k + 1, acc);
          acc.pop();
          rowFree[ti2][r2]++; colCount[ti2][col]--; delete rowColUsed[ti2][r2][col];
          if (solutions.length >= CAP) return;
        }
      }
    }
    solve(0, []);

    /* Standard tambola generators never leave a column of a ticket empty.
       Use that to break ties between otherwise-legal solutions.            */
    if (solutions.length > 1 && solutions.length < CAP) {
      var full = solutions.filter(function (s) {
        var cc = [];
        for (var q = 0; q < 6; q++) cc.push(colCount[q].slice());
        s.forEach(function (a2) { cc[a2.ti][a2.c]++; });
        for (var q2 = 0; q2 < 6; q2++) for (var c2 = 0; c2 < 9; c2++) if (cc[q2][c2] === 0) return false;
        return true;
      });
      if (full.length >= 1) solutions = full;
    }

    var apply;
    if (solutions.length === 1) apply = solutions[0];
    else if (solutions.length > 1 && solutions.length < CAP) {
      /* Ambiguous overall — but any placement that is IDENTICAL in every
         legal solution is still certain. Fill those, leave the rest blank
         for the user to see flagged.                                      */
      apply = solutions[0].filter(function (p0) {
        return solutions.every(function (s) {
          return s.some(function (p) { return p.v === p0.v && p.ti === p0.ti && p.r === p0.r && p.c === p0.c; });
        });
      });
    } else apply = [];

    apply.forEach(function (s) { tickets[s.ti].numbers[s.r * 9 + s.c] = s.v; });
    sortColumns(tickets);
    return apply.length;
  }

  /* ── 11. PAGE PARSE ──────────────────────────────────────────────────── */
  function parsePage(rawItems, ctx) {
    var tokens = tokenize(rawItems);
    if (!tokens.length) return { sheets: [], diag: { reason: 'no-tokens' } };
    var consumed = new Set();

    // -- confident single/double digit numbers define the geometry
    var conf = [];
    for (var i = 0; i < tokens.length; i++) {
      var v = numValue(tokens[i].t);
      if (v !== null) { tokens[i].v = v; conf.push(tokens[i]); }
    }
    if (conf.length < 15) return { sheets: [], diag: { reason: 'too-few-numbers', found: conf.length } };

    // -- reject size outliers (giant watermarks, tiny footers)
    var mh = med(conf.map(function (t) { return t.h; })) || 10;
    conf = conf.filter(function (t) { return t.h >= mh * 0.55 && t.h <= mh * 1.75; });

    // -- reject anything off the number grid
    var grid = buildXGrid(conf);
    var nums = conf.filter(function (t) { return onGrid(grid, t.cx); });
    if (nums.length < 15) nums = conf;

    nums.forEach(function (n) { consumed.add(n); });

    // -- rows
    var bands = bandRows(nums);

    /* -- rescue pass: some renderers glue two cells together ("2143").
       Only fires for a token sitting INSIDE a row that is short of a clean
       multiple of 5, and only if both halves land in free columns. This
       keeps ticket ids / sheet numbers / prices from being shredded.     */
    (function () {
      var rowTol = Math.max(mh * 0.5, 2.5);
      var glued = tokens.filter(function (t) {
        return !consumed.has(t) && /^\d{3,4}$/.test(t.t) &&
          t.h >= mh * 0.55 && t.h <= mh * 1.75 &&
          (onGrid(grid, t.cx) || onGrid(grid, t.x0 + t.w * 0.25));
      });
      if (!glued.length) return;
      for (var bi = 0; bi < bands.length; bi++) {
        var band = bands[bi];
        if (band.items.length % 5 === 0 && band.items.length > 0) continue;
        for (var gi = 0; gi < glued.length; gi++) {
          var tk = glued[gi];
          if (consumed.has(tk)) continue;
          if (Math.abs(tk.cy - band.cy) > rowTol) continue;
          var pair = splitMerged(tk.t);
          if (!pair) continue;
          var taken = {};
          band.items.forEach(function (n) { taken[n2col(n.v)] = 1; });
          var c0 = n2col(pair[0]), c1 = n2col(pair[1]);
          if (c0 < 0 || c1 < 0 || c0 === c1 || taken[c0] || taken[c1]) continue;
          var half = tk.w / 2;
          var a = { t: String(pair[0]), v: pair[0], x0: tk.x0, x1: tk.x0 + half, y0: tk.y0, y1: tk.y1, cx: tk.x0 + half / 2, cy: tk.cy, w: half, h: tk.h, split: true };
          var b = { t: String(pair[1]), v: pair[1], x0: tk.x0 + half, x1: tk.x1, y0: tk.y0, y1: tk.y1, cx: tk.x1 - half / 2, cy: tk.cy, w: half, h: tk.h, split: true };
          band.items.push(a, b);
          band.items.sort(function (p, q) { return p.cx - q.cx; });
          nums.push(a, b);
          consumed.add(tk); consumed.add(a); consumed.add(b);
        }
      }
    })();

    bands = bands.filter(function (b) { return b.items.length >= 3; });
    if (!bands.length) return { sheets: [], diag: { reason: 'no-rows' } };
    var rowPitch = bands.length > 1
      ? med(bands.slice(1).map(function (b, i) { return b.cy - bands[i].cy; })) : mh * 1.6;
    var groups = groupBands(bands);

    // -- per-column reference x (for collision resolution)
    var colX = {};
    (function () {
      var buckets = {};
      nums.forEach(function (n) { var c = n2col(n.v); if (c >= 0) (buckets[c] = buckets[c] || []).push(n.cx); });
      Object.keys(buckets).forEach(function (c) { colX[c] = med(buckets[c]); });
    })();

    // -- build ticket blocks
    var blocks = [];
    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g];
      var total = grp.reduce(function (s, b) { return s + b.items.length; }, 0);
      var k = Math.max(1, Math.round(total / 15));
      var perBand = grp.map(function (b) { return splitSegments(b.items, k); });
      for (var s = 0; s < k; s++) {
        var rows = perBand.map(function (segs) { return segs[s] || []; });
        var flat = rows.reduce(function (a, r) { return a.concat(r); }, []);
        if (flat.length < 6) continue;
        var placed = placeTicket(rows, colX);
        blocks.push({
          numbers: placed.numbers,
          issues: placed.issues,
          count: flat.length,
          rows: rows.filter(function (r) { return r.length; }).length,
          box: {
            x0: Math.min.apply(null, flat.map(function (n) { return n.x0; })),
            x1: Math.max.apply(null, flat.map(function (n) { return n.x1; })),
            y0: Math.min.apply(null, flat.map(function (n) { return n.y0; })),
            y1: Math.max.apply(null, flat.map(function (n) { return n.y1; }))
          },
          cy: med(flat.map(function (n) { return n.cy; }))
        });
      }
    }
    if (!blocks.length) return { sheets: [], diag: { reason: 'no-blocks' } };

    // -- labels & ids
    var labels = findSheetLabels(tokens, consumed);
    if (labels.length > 1) {
      var expect = Math.max(1, Math.round(blocks.length / 6));
      if (labels.length !== expect) {
        labels.sort(function (a, b) { return b.score - a.score; });
        labels = [labels[0]];
      }
    }
    labels.forEach(function (l) { l.tokens.forEach(function (t) { consumed.add(t); }); });
    var ids = assignIds(blocks, tokens, consumed, rowPitch);

    // -- attach blocks to sheets
    var sheets = [];
    function sheetFor(block, bi) {
      var name;
      if (labels.length === 1) name = labels[0].name;
      else if (labels.length > 1) {
        var best = labels[0], bd = Math.abs(labels[0].cy - block.cy);
        for (var l = 1; l < labels.length; l++) {
          var d = Math.abs(labels[l].cy - block.cy);
          if (d < bd) { bd = d; best = labels[l]; }
        }
        name = best.name;
      } else name = ctx.fallback;
      var sh = sheets.find(function (x) { return x.name === name; });
      if (!sh) { sh = { name: name, tickets: [] }; sheets.push(sh); }
      return sh;
    }
    for (var b = 0; b < blocks.length; b++) {
      var sh = sheetFor(blocks[b], b);
      var idTok = ids[b];
      var id = idTok ? idTok.t.replace(/[^\w\-]/g, '') : String(sh.tickets.length + 1);
      while (sh.tickets.some(function (t) { return t.id === id; })) id = id + '·';
      sh.tickets.push({ id: id, numbers: blocks[b].numbers, _issues: blocks[b].issues, _count: blocks[b].count });
    }
    return { sheets: sheets, diag: { blocks: blocks.length, labels: labels.length, rowPitch: rowPitch } };
  }

  /* ── 12. PUBLIC ENTRY ────────────────────────────────────────────────── */
  function parsePages(pages, fallback) {
    var all = [], diags = [];
    for (var p = 0; p < pages.length; p++) {
      var r = parsePage(pages[p], { fallback: pages.length > 1 ? fallback + '-' + (p + 1) : fallback });
      diags.push(r.diag);
      for (var s = 0; s < r.sheets.length; s++) {
        var sh = r.sheets[s];
        var ex = all.find(function (x) { return x.name === sh.name; });
        if (ex) {
          sh.tickets.forEach(function (t) {
            var id = t.id;
            while (ex.tickets.some(function (q) { return q.id === id; })) id += '·';
            t.id = id; ex.tickets.push(t);
          });
        } else all.push(sh);
      }
    }
    var repaired = 0;
    all.forEach(function (sh) { repaired += repairSheet(sh); });
    return { sheets: all, diag: { pages: diags, repaired: repaired } };
  }


  /* ═════════════════════════════════════════════════════════════════════════
     BROWSER FILE LAYER — turns any file into pages of token boxes
     ═══════════════════════════════════════════════════════════════════════ */

  var CFG = {
    ocrApiKey: 'helloworld',           // same free key your app uses today.
                                       // 'helloworld' is OCR.space's shared demo
                                       // key and is heavily rate-limited — get a
                                       // free personal key at ocr.space/ocrapi
    ocrUrl: 'https://api.ocr.space/parse/image',
    ocrEngine: 2,
    ocrScale: 2.0,                     // render scale for scanned PDF pages
    maxOcrPages: 12
  };
  function config(o) { for (var k in o) if (o.hasOwnProperty(k)) CFG[k] = o[k]; }

  /* ── ticket shape expected by the rest of the app ── */
  function mkTicket(id) {
    return {
      id: id, numbers: new Array(27).fill(null), marked: new Array(27).fill(false),
      hasWin: false, winType: null, winTypes: [], claimedRows: [],
      fullHouseClaimed: false, earlyFiveClaimed: false,
      earlySixClaimed: false, earlySevenClaimed: false, ticketCornersClaimed: false
    };
  }
  function toAppSheets(sheets) {
    return sheets.map(function (sh) {
      return {
        name: sh.name,
        tickets: sh.tickets.map(function (t) {
          var tk = mkTicket(t.id);
          tk.numbers = t.numbers;
          return tk;
        })
      };
    });
  }

  /* ── PDF ▸ token boxes (pdf.js) ─────────────────────────────────────────
     item.transform is in PDF space (y up). The viewport transform converts
     it to screen space (y down) which is what the engine expects.        */
  function pdfPageItems(page) {
    return page.getTextContent().then(function (tc) {
      var vp = page.getViewport({ scale: 1 });
      var U = (root.pdfjsLib && root.pdfjsLib.Util) || null;
      var out = [];
      for (var i = 0; i < tc.items.length; i++) {
        var it = tc.items[i];
        if (!it.str || !it.str.trim()) continue;
        var m = U ? U.transform(vp.transform, it.transform) : it.transform;
        var sx = Math.hypot(m[0], m[1]) || 1;
        var sy = Math.hypot(m[2], m[3]) || 1;
        var h = (it.height || 0) * sy;
        if (!h) h = sy || 10;
        var w = (it.width || 0) * sx;
        if (!w) w = h * 0.6 * Math.max(1, it.str.trim().length);
        // m[4],m[5] is the baseline origin in screen space
        out.push({ str: it.str, x: m[4], y: m[5] - h, w: w, h: h });
      }
      return out;
    });
  }

  function readPdfItems(file) {
    if (!root.pdfjsLib) return Promise.reject(new Error('pdf.js not loaded'));
    return file.arrayBuffer().then(function (buf) {
      return root.pdfjsLib.getDocument({ data: buf }).promise;
    }).then(function (pdf) {
      var pages = [], chain = Promise.resolve();
      for (var p = 1; p <= pdf.numPages; p++) {
        (function (n) {
          chain = chain.then(function () {
            return pdf.getPage(n).then(pdfPageItems).then(function (items) { pages[n - 1] = items; });
          });
        })(p);
      }
      return chain.then(function () { return { pages: pages, pdf: pdf }; });
    });
  }

  /* ── OCR ▸ token boxes (OCR.space overlay) ───────────────────────────── */
  function ocrBlob(blob, filename) {
    var fd = new FormData();
    fd.append('file', blob, filename || 'page.png');
    fd.append('apikey', CFG.ocrApiKey);
    fd.append('isOverlayRequired', 'true');
    fd.append('OCREngine', String(CFG.ocrEngine));
    fd.append('scale', 'true');
    fd.append('detectOrientation', 'true');
    return fetch(CFG.ocrUrl, { method: 'POST', body: fd }).then(function (r) {
      if (!r.ok) throw new Error('OCR service unavailable (' + r.status + ')');
      return r.json();
    }).then(function (data) {
      if (data.IsErroredOnProcessing) {
        throw new Error((data.ErrorMessage && data.ErrorMessage[0]) || 'OCR failed');
      }
      var pages = [];
      (data.ParsedResults || []).forEach(function (res) {
        var items = [];
        var lines = (res.TextOverlay && res.TextOverlay.Lines) || [];
        lines.forEach(function (ln) {
          (ln.Words || []).forEach(function (w) {
            if (!w.WordText || !w.WordText.trim()) return;
            items.push({ str: w.WordText, x: w.Left, y: w.Top, w: w.Width, h: w.Height });
          });
        });
        pages.push(items);
      });
      return pages;
    });
  }

  /* ── render a PDF page to PNG so it can be OCR'd ── */
  function pageToBlob(page) {
    var vp = page.getViewport({ scale: CFG.ocrScale });
    var cv = document.createElement('canvas');
    cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
      return new Promise(function (res) { cv.toBlob(res, 'image/png'); });
    });
  }

  /* ── quality score: how much of a parse actually looks like tickets ── */
  function score(sheets) {
    var good = 0, total = 0;
    sheets.forEach(function (sh) {
      sh.tickets.forEach(function (t) {
        total++;
        var c = 0; t.numbers.forEach(function (n) { if (n !== null) c++; });
        if (c === 15) good++;
      });
    });
    return { good: good, total: total, ratio: total ? good / total : 0 };
  }

  /* ── MAIN ENTRY ─────────────────────────────────────────────────────────
     Returns { sheets, method, diag, warnings }                            */
  function parseFile(file) {
    var name = (file.name || 'sheet').toLowerCase();
    var base = (file.name || 'sheet').replace(/\.[^/.]+$/, '');

    // JSON — straight through
    if (name.endsWith('.json')) {
      return file.text().then(function (txt) {
        var d = JSON.parse(txt);
        var arr = Array.isArray(d) ? d : (d.sheets ? d.sheets : [d]);
        return { sheets: arr, method: 'json', diag: {}, warnings: [] };
      });
    }

    // Images — OCR only
    if (/\.(jpe?g|png|webp|bmp|gif|tiff?)$/.test(name)) {
      return ocrBlob(file, file.name).then(function (pages) {
        var r = parsePages(pages, base);
        return { sheets: toAppSheets(r.sheets), method: 'ocr-image', diag: r.diag, warnings: [] };
      });
    }

    // PDF — text layer first, OCR fallback per whole document
    if (name.endsWith('.pdf')) {
      return readPdfItems(file).then(function (res) {
        var textRun = parsePages(res.pages, base);
        var s1 = score(textRun.sheets);
        if (s1.total && s1.ratio >= 0.999) {
          return { sheets: toAppSheets(textRun.sheets), method: 'pdf-text', diag: textRun.diag, warnings: [] };
        }
        // text layer missing or partial → OCR the pages and take the better result
        var n = Math.min(res.pdf.numPages, CFG.maxOcrPages);
        var chain = Promise.resolve(), ocrPages = [];
        for (var p = 1; p <= n; p++) {
          (function (i) {
            chain = chain.then(function () {
              return res.pdf.getPage(i).then(pageToBlob).then(function (b) {
                return ocrBlob(b, 'p' + i + '.png');
              }).then(function (pp) { ocrPages[i - 1] = (pp && pp[0]) || []; });
            });
          })(p);
        }
        return chain.then(function () {
          var ocrRun = parsePages(ocrPages, base);
          var s2 = score(ocrRun.sheets);
          var useOcr = s2.good > s1.good;
          var chosen = useOcr ? ocrRun : textRun;
          return {
            sheets: toAppSheets(chosen.sheets),
            method: useOcr ? 'pdf-ocr' : 'pdf-text',
            diag: chosen.diag,
            warnings: s1.total && s1.ratio < 1 ? ['partial text layer'] : []
          };
        }).catch(function (e) {
          if (s1.total) {
            return {
              sheets: toAppSheets(textRun.sheets), method: 'pdf-text',
              diag: textRun.diag, warnings: ['OCR fallback failed: ' + e.message]
            };
          }
          throw e;
        });
      });
    }

    // anything else: treat as text and let the engine see it as one item per line
    return file.text().then(function (txt) {
      var lines = txt.split(/\r?\n/), items = [], y = 0;
      lines.forEach(function (ln) {
        if (ln.trim()) items.push({ str: ln, x: 0, y: y, w: Math.max(10, ln.length * 7), h: 12 });
        y += 16;
      });
      var r = parsePages([items], base);
      return { sheets: toAppSheets(r.sheets), method: 'text', diag: r.diag, warnings: [] };
    });
  }

  /* ── report card for the UI ── */
  function inspect(sheets) {
    var bad = [];
    sheets.forEach(function (sh) {
      var seen = {};
      sh.tickets.forEach(function (t) {
        var nums = t.numbers.filter(function (n) { return n !== null; });
        var rows = [0, 1, 2].map(function (r) {
          return t.numbers.slice(r * 9, r * 9 + 9).filter(function (n) { return n !== null; }).length;
        });
        nums.forEach(function (n) { seen[n] = (seen[n] || 0) + 1; });
        if (nums.length !== 15 || rows.some(function (r) { return r !== 5; })) {
          bad.push({
            sheetName: sh.name, ticketId: t.id,
            rows: rows.filter(function (r) { return r > 0; }).length,
            count: nums.length, nums: nums
          });
        }
      });
    });
    return bad;
  }

  var API = {
    parseFile: parseFile, config: config, inspect: inspect,
    parsePages: parsePages, tokenize: tokenize, n2col: n2col,
    repairSheet: repairSheet, toAppSheets: toAppSheets
  };
  root.TBFiles = API;
  root.TBParse = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : this);
