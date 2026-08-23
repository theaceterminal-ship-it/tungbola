/* ═══════════════════════════════════════════════════════════════════════════
   TUNGBOLA UNIVERSAL SHEET PARSER  ·  v3
   ───────────────────────────────────────────────────────────────────────────
   One engine for every organiser's layout. Reads TOKEN BOXES (x/y/width/
   height), never lines of text, never brand names, never a fixed vendor
   layout.

       vector PDF  ──▶ pdf.js text items ──┐
       scanned PDF ──▶ render ▸ OCR boxes ─┼──▶ geometry engine ──▶ tickets
       JPG / PNG   ──▶ OCR word boxes ─────┘
       JSON        ──▶ passthrough

   Structure is recovered from geometry and then checked against the
   invariants every tambola sheet obeys:

       · a ticket  = 3 rows x 5 numbers = 15 numbers
       · column c  = 1-9, 10-19, 20-29 … 80-90
       · a column of a ticket holds 1..3 numbers
       · a 6-ticket sheet holds each of 1..90 exactly once

   WHAT MAKES IT FORMAT-AGNOSTIC (v3)
   ──────────────────────────────────
   1. Correct page geometry. pdf.js reports item.width / item.height already
      in page units; v2 multiplied them by the text-matrix scale a second
      time, inflating every box by roughly the font size. Row banding, the
      x-grid gate and the size-outlier filter all take their tolerances from
      those numbers, so on many sheets three ticket rows collapsed into one
      band and six tickets came back as two or three broken ones. v3 builds a
      true rotation-aware bounding box per item.
   2. Rotated text. Sheet labels and ticket ids are often printed sideways.
      Boxes and sub-token positions now follow the text's own advance
      direction, and a page whose numbers run vertically is turned upright
      before parsing.
   3. Self-tuning. Instead of one hand-tuned set of thresholds, the engine
      searches a small space of segmentation hypotheses and keeps whichever
      one best satisfies the invariants above. New layouts tune themselves.
   4. Invariant repair. Numbers OCR dropped are restored by constraint
      solving, and OCR digit confusions (0/8, 1/7, 5/6 …) are corrected —
      both only when the answer is provably unique. It never guesses.

   USAGE
       const res = await TBFiles.parseFile(file);   // any file type
       res.sheets   // app-shaped sheets
       res.method   // 'pdf-text' | 'pdf-ocr' | 'ocr-image' | 'json' | 'text'
       res.diag     // per-page diagnostics (winning hypothesis, counts…)

   OCR key (scanned PDFs / images only) — the built-in key is OCR.space's
   shared demo key and is heavily rate limited. Get a free personal key at
   ocr.space/ocrapi and set it:

       TBFiles.config({ ocrApiKey: 'YOUR_KEY' });

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

  /* Wall-clock ceilings. A clean page finishes in a millisecond or two and
     never comes near these; they exist so a badly damaged page — where the
     hypothesis search and the constraint solver both have real work to do and
     the answer is unrecoverable anyway — cannot stall the upload. Tunable via
     TBFiles.config({ pageBudgetMs, repairBudgetMs }).                      */
  var BUDGET = { page: 900, repair: 400 };
  function normLig(s) {
    return String(s).replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi')
      .replace(/ﬂ/g, 'fl').replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
      .replace(/ /g, ' ');
  }

  /* ── 1. TOKENISE ─────────────────────────────────────────────────────────
     input  raw item : {str, x, y, w, h, vert?, dir?}
                       x,y = LEFT/TOP of the box, y grows DOWNWARD
                       vert = the text runs along y;  dir = +1/-1 advance sign
     output token    : {t, x0,x1,y0,y1, cx,cy, w,h, vert}

     Producers routinely emit a whole ticket row as ONE item ("18 25 39").
     Sub-tokens are placed by interpolating along the item's own advance
     direction — pdf.js pads such strings with spaces proportional to the real
     gap, so character-offset interpolation lands within a glyph of the truth. */
  function tokenize(raw) {
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var it = raw[i];
      var s = normLig(it.str == null ? '' : it.str);
      if (!s.trim()) continue;
      var w = it.w || 0, h = it.h || 0;
      var vert = !!it.vert, dir = it.dir === -1 ? -1 : 1;
      var span = vert ? h : w;
      var parts = [], re = /\S+/g, m;
      while ((m = re.exec(s))) parts.push({ t: m[0], i: m.index });
      if (!parts.length) continue;
      if (parts.length === 1 || !span) {
        out.push({
          t: parts.length === 1 ? parts[0].t : s.trim(),
          x0: it.x, x1: it.x + w, y0: it.y, y1: it.y + h, vert: vert
        });
      } else {
        var len = s.length || 1;
        for (var p = 0; p < parts.length; p++) {
          var a = parts[p].i / len, b = (parts[p].i + parts[p].t.length) / len;
          if (dir === -1) { var t0 = 1 - b; b = 1 - a; a = t0; }
          if (vert) out.push({ t: parts[p].t, x0: it.x, x1: it.x + w, y0: it.y + a * h, y1: it.y + b * h, vert: true, est: true });
          else      out.push({ t: parts[p].t, x0: it.x + a * w, x1: it.x + b * w, y0: it.y, y1: it.y + h, vert: false, est: true });
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

  /* ── 1b. ORIENTATION ─────────────────────────────────────────────────────
     Some organisers print the whole sheet sideways (landscape artwork on a
     portrait page, or a rotated scan). If the numbers themselves run
     vertically, turn every box upright and let the rest of the engine work in
     its normal frame.                                                       */
  function rotateTokens(tokens) {
    return tokens.map(function (o) {
      var x0 = o.y0, x1 = o.y1, y0 = -o.x1, y1 = -o.x0;
      return {
        t: o.t, x0: x0, x1: x1, y0: y0, y1: y1,
        cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
        w: x1 - x0, h: y1 - y0, vert: !o.vert, est: o.est
      };
    });
  }
  function needsRotation(tokens) {
    var vn = 0, hn = 0;
    for (var i = 0; i < tokens.length; i++) {
      if (numValue(tokens[i].t) === null) continue;
      if (tokens[i].vert) vn++; else hn++;
    }
    return vn >= 15 && vn > hn * 1.5;
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
  function bandRows(nums, tolF) {
    var sorted = nums.slice().sort(function (a, b) { return a.cy - b.cy; });
    var h = med(nums.map(function (n) { return n.h; })) || 10;
    var tol = Math.max(h * tolF, 2.5);
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

  /* ── 4b. GLUE SPLIT DIGITS ───────────────────────────────────────────────
     OCR often returns "17" as two boxes, "1" and "7". Two single digits that
     sit far closer together than the row's normal number spacing are one
     number, not two — and two numbers from the same decade can never share a
     ticket row anyway, so the merge is safe. Runs per row so that a sheet
     whose numbers really are single digits is left alone.                  */
  function glueFragments(nums, mh) {
    var bands = bandRows(nums, 0.5), out = [], merged = 0;
    bands.forEach(function (band) {
      var it = band.items;
      if (it.length < 3) { out.push.apply(out, it); return; }
      var i = 0;
      while (i < it.length) {
        var a = it[i], b = it[i + 1];
        /* Only ever joins two SINGLE-digit boxes, and only when they are
           closer than half a glyph apart. A producer that emits whole numbers
           never trips it, and two real single-digit numbers cannot share a
           row anyway — 1-9 is one column, and a row uses each column once. */
        var thr = b ? Math.min(Math.min(a.w, b.w) * 0.6, mh * 0.45) : 0;
        if (b && /^\d$/.test(a.t) && /^\d$/.test(b.t) && (b.x0 - a.x1) <= thr) {
          var v = parseInt(a.t + b.t, 10);
          if (v >= 1 && v <= 90) {
            out.push({
              t: a.t + b.t, v: v,
              x0: a.x0, x1: b.x1, y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1),
              cx: (a.x0 + b.x1) / 2, cy: (a.cy + b.cy) / 2,
              w: b.x1 - a.x0, h: Math.max(a.h, b.h), glued: true, src: [a, b]
            });
            i += 2; merged++; continue;
          }
        }
        out.push(a); i++;
      }
    });
    return merged ? out : nums;
  }

  /* ── 5. GROUP BANDS INTO TICKET BLOCKS ───────────────────────────────── */
  function groupBands(bands, gapF) {
    if (bands.length <= 3) return [bands];
    var gaps = [];
    for (var i = 1; i < bands.length; i++) gaps.push(bands[i].cy - bands[i - 1].cy);
    var mg = med(gaps) || 1;
    var groups = [], cur = [bands[0]];
    for (var j = 1; j < bands.length; j++) {
      if (gaps[j - 1] > mg * gapF) { groups.push(cur); cur = [bands[j]]; }
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
  function groupByThree(bands) {                 // ignore vertical gaps entirely
    var out = [];
    for (var s = 0; s < bands.length; s += 3) out.push(bands.slice(s, s + 3));
    return out;
  }

  /* ── 6. SPLIT A ROW-GROUP INTO k SIDE-BY-SIDE TICKETS ────────────────────
     Three strategies; the hypothesis search picks whichever satisfies the
     invariants for this particular sheet.
       union — cut at the k-1 widest x-gaps measured across the whole group
               (ticket borders line up across all three rows)
       band  — cut each row independently at its own k-1 widest gaps
       chunk — every ticket row holds exactly 5 numbers, so just take
               consecutive runs of 5                                        */
  function segmentGroup(grp, k, mode) {
    if (k <= 1) return grp.map(function (b) { return [b.items]; });
    if (mode === 'chunk') {
      return grp.map(function (b) {
        var segs = [], n = b.items.length;
        var per = n % k === 0 ? n / k : Math.ceil(n / k);
        for (var s = 0; s < k; s++) segs.push(b.items.slice(s * per, (s + 1) * per));
        return segs;
      });
    }
    if (mode === 'band') {
      return grp.map(function (b) { return cutByGaps(b.items, k); });
    }
    // 'union'
    var all = grp.reduce(function (a, b) { return a.concat(b.items); }, [])
      .slice().sort(function (p, q) { return p.cx - q.cx; });
    if (all.length < 2) return grp.map(function (b) { return cutByGaps(b.items, k); });
    var gaps = [];
    for (var i = 1; i < all.length; i++)
      gaps.push({ x: (all[i].x0 + all[i - 1].x1) / 2, g: all[i].x0 - all[i - 1].x1 });
    gaps.sort(function (a, b) { return b.g - a.g; });
    var cuts = gaps.slice(0, k - 1).map(function (o) { return o.x; }).sort(function (a, b) { return a - b; });
    return grp.map(function (b) {
      var segs = [];
      for (var s = 0; s < k; s++) segs.push([]);
      b.items.forEach(function (it) {
        var s = 0;
        while (s < cuts.length && it.cx > cuts[s]) s++;
        segs[s].push(it);
      });
      return segs;
    });
  }
  function cutByGaps(items, k) {
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

  /* ── 7. PLACE NUMBERS INTO THE 3x9 GRID ──────────────────────────────────
     The column comes from the VALUE (1-9, 10-19 …), never from x. That is a
     hard rule of the game, so it holds for every organiser's artwork.

     We do record, per cell, which column the number was actually PRINTED in
     (xcol). For clean input the two always agree. When they disagree, OCR
     misread a tens digit — 51 read as 61 still sits under the 50s column —
     and repair uses that to tell the misread copy from the genuine one.   */
  function xcolOf(cx, colX) {
    var best = -1, bd = Infinity;
    for (var c = 0; c < 9; c++) {
      if (colX[c] == null) continue;
      var d = Math.abs(colX[c] - cx);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }
  function placeTicket(rowSegs, colX) {
    var numbers = new Array(27).fill(null), xcols = new Array(27).fill(-1), issues = [];
    for (var ri = 0; ri < Math.min(3, rowSegs.length); ri++) {
      var row = rowSegs[ri] || [];
      for (var i = 0; i < row.length; i++) {
        var it = row[i], v = it.v, col = n2col(v);
        if (col < 0) { issues.push('range:' + v); continue; }
        var idx = ri * 9 + col;
        if (numbers[idx] === null) { numbers[idx] = v; xcols[idx] = xcolOf(it.cx, colX); }
        else {
          // two numbers claim one cell -> keep the one nearest that column's x
          var prev = numbers[idx], want = colX && colX[col];
          if (want != null) {
            var prevIt = null;
            for (var q = 0; q < row.length; q++) if (row[q].v === prev) { prevIt = row[q]; break; }
            var dPrev = prevIt ? Math.abs(prevIt.cx - want) : 1e9;
            var dCur = Math.abs(it.cx - want);
            if (dCur < dPrev) { numbers[idx] = v; xcols[idx] = xcolOf(it.cx, colX); issues.push('collide:' + prev); }
            else issues.push('collide:' + v);
          } else issues.push('collide:' + v);
        }
      }
    }
    return { numbers: numbers, xcols: xcols, issues: issues };
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
      var reach = Math.max(anchor.w, anchor.h) * 1.4;
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
  function colAscending(t, c) {                   // as printed, before sortColumns
    var prev = -1;
    for (var r = 0; r < 3; r++) {
      var v = t.numbers[r * 9 + c];
      if (v === null) continue;
      if (v <= prev) return false;
      prev = v;
    }
    return true;
  }
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

  /* Digit shapes OCR routinely swaps. Used ONLY to reconcile a duplicated
     number against a missing one, and only when exactly one reading works. */
  var CONFUSE = {
    '0': '689', '1': '747', '2': '73', '3': '895', '4': '19',
    '5': '683', '6': '5089', '7': '129', '8': '03569', '9': '478'
  };
  function confusable(a, b) {                     // same length, one digit apart
    var A = String(a), B = String(b);
    if (A.length !== B.length) return false;
    var diff = -1;
    for (var i = 0; i < A.length; i++) {
      if (A[i] === B[i]) continue;
      if (diff >= 0) return false;
      diff = i;
    }
    if (diff < 0) return false;
    return (CONFUSE[A[diff]] || '').indexOf(B[diff]) >= 0 ||
           (CONFUSE[B[diff]] || '').indexOf(A[diff]) >= 0;
  }

  /* ── occupancy model shared by both repairs ─────────────────────────────
     rowFree[t][r]  slots still open in that row      (a row holds 5)
     colCount[t][c] numbers already in that column    (a column holds 1..3)
     used[t][r][c]  is that single cell taken                              */
  function buildState(tickets) {
    var st = { rowFree: [], colCount: [], used: [] };
    for (var ti = 0; ti < 6; ti++) {
      var t = tickets[ti], rc = [0, 0, 0], cc = [], used = [{}, {}, {}];
      for (var c = 0; c < 9; c++) cc.push(0);
      for (var i = 0; i < 27; i++) {
        if (t.numbers[i] === null) continue;
        var r = Math.floor(i / 9), cd = i % 9;
        rc[r]++; cc[cd]++; used[r][cd] = 1;
      }
      st.rowFree.push([5 - rc[0], 5 - rc[1], 5 - rc[2]]);
      st.colCount.push(cc); st.used.push(used);
    }
    return st;
  }
  function freeSlots(st) {
    var n = 0;
    for (var ti = 0; ti < 6; ti++) n += st.rowFree[ti][0] + st.rowFree[ti][1] + st.rowFree[ti][2];
    return n;
  }
  function missingOf(tickets) {
    var present = {}, out = [];
    tickets.forEach(function (t) {
      t.numbers.forEach(function (v) { if (v !== null) present[v] = (present[v] || 0) + 1; });
    });
    for (var n = 1; n <= 90; n++) if (!present[n]) out.push(n);
    return out;
  }
  /* every cell a given value could legally still occupy */
  function candidates(st, v) {
    var col = n2col(v), out = [];
    if (col < 0) return out;
    for (var ti = 0; ti < 6; ti++) {
      if (st.colCount[ti][col] >= 3) continue;
      for (var r = 0; r < 3; r++) {
        if (st.rowFree[ti][r] <= 0) continue;
        if (st.used[ti][r][col]) continue;
        out.push({ ti: ti, r: r, c: col });
      }
    }
    return out;
  }
  /* Is there ANY legal way to place every remaining number? Depth-first with
     most-constrained-value ordering, stopping at the first solution.
     strictCols additionally demands what real generators always produce: no
     ticket column left completely empty.                                  */
  function existsSolution(st, missing, strictCols) {
    var budget = 60000;
    function rec(list) {
      if (budget-- <= 0) return false;
      if (!list.length) {
        if (!strictCols) return true;
        for (var ti = 0; ti < 6; ti++)
          for (var c = 0; c < 9; c++) if (st.colCount[ti][c] === 0) return false;
        return true;
      }
      var bi = -1, bc = null;
      for (var i = 0; i < list.length; i++) {
        var cs = candidates(st, list[i]);
        if (!cs.length) return false;
        if (bc === null || cs.length < bc.length) { bc = cs; bi = i; if (cs.length === 1) break; }
      }
      var v = list[bi], rest = list.slice(0, bi).concat(list.slice(bi + 1));
      for (var k = 0; k < bc.length; k++) {
        var p = bc[k];
        st.rowFree[p.ti][p.r]--; st.colCount[p.ti][p.c]++; st.used[p.ti][p.r][p.c] = 1;
        var ok = rec(rest);
        st.rowFree[p.ti][p.r]++; st.colCount[p.ti][p.c]--; delete st.used[p.ti][p.r][p.c];
        if (ok) return true;
      }
      return false;
    }
    return rec(missing.slice());
  }

  /* ── fill the holes OCR left ────────────────────────────────────────────
     A value is written into a cell only when every legal completion of the
     sheet puts it there — i.e. no other candidate cell for that value can be
     extended to a full solution. That is a proof, not a guess. Forced
     placements found in one sweep are mutually consistent (each appears in
     every solution), so they are applied together and the sweep repeats.  */
  function fillMissing(tickets, deadline) {
    var applied = 0;
    for (var pass = 0; pass < 30; pass++) {
      if (Date.now() > deadline) break;
      var st = buildState(tickets), missing = missingOf(tickets);
      if (!missing.length || missing.length > 20) break;
      if (freeSlots(st) !== missing.length) break;   // duplicates / stray numbers
      var strict = existsSolution(st, missing, true);
      if (!strict && !existsSolution(st, missing, false)) break;

      var forced = [];
      for (var mi = 0; mi < missing.length; mi++) {
        if (Date.now() > deadline) break;
        var v = missing[mi], cs = candidates(st, v), good = null, many = false;
        var rest = missing.filter(function (x) { return x !== v; });
        for (var k = 0; k < cs.length; k++) {
          var p = cs[k];
          st.rowFree[p.ti][p.r]--; st.colCount[p.ti][p.c]++; st.used[p.ti][p.r][p.c] = 1;
          var ok = existsSolution(st, rest, strict);
          st.rowFree[p.ti][p.r]++; st.colCount[p.ti][p.c]--; delete st.used[p.ti][p.r][p.c];
          if (!ok) continue;
          if (good) { many = true; break; }
          good = p;
        }
        if (good && !many) forced.push({ v: v, p: good });
      }
      if (!forced.length) break;
      forced.forEach(function (f) { tickets[f.p.ti].numbers[f.p.r * 9 + f.p.c] = f.v; });
      applied += forced.length;
    }
    return applied;
  }

  /* ── correct OCR digit misreads ─────────────────────────────────────────
     A number that appears twice while a same-shaped number is missing was
     misread. Try every (which copy, which missing value) pairing that leaves
     a legal cell, keep only those that leave the whole sheet completable,
     and rewrite only when exactly one survives.                           */
  function fixConfusions(tickets, deadline) {
    var slots = {}, applied = 0;
    tickets.forEach(function (t, ti) {
      t.numbers.forEach(function (v, i) { if (v !== null) (slots[v] = slots[v] || []).push({ ti: ti, i: i }); });
    });
    var missing = missingOf(tickets);
    if (!missing.length) return 0;
    var dups = [];
    Object.keys(slots).forEach(function (k) { if (slots[k].length > 1) dups.push(parseInt(k, 10)); });
    if (!dups.length) return 0;

    for (var d = 0; d < dups.length; d++) {
      if (Date.now() > deadline) break;
      var v = dups[d], where = slots[v] || [];
      if (where.length < 2) continue;
      var opts = [];
      for (var w = 0; w < where.length && opts.length <= 6; w++) {
        for (var m = 0; m < missing.length && opts.length <= 6; m++) {
          var mv = missing[m];
          if (!confusable(v, mv)) continue;
          var slot = where[w], t = tickets[slot.ti];
          var r = Math.floor(slot.i / 9), c = n2col(mv);
          if (c < 0) continue;
          var target = r * 9 + c;
          if (target !== slot.i && t.numbers[target] !== null) continue;   // cell taken
          var cc = 0;                                                     // column capacity after the move
          for (var rr = 0; rr < 3; rr++) {
            var idx = rr * 9 + c;
            if (idx !== slot.i && t.numbers[idx] !== null) cc++;
          }
          if (cc >= 3) continue;
          opts.push({ slot: slot, target: target, mv: mv });
        }
      }
      if (!opts.length) continue;

      /* The printed column breaks the tie. A tens digit misread (51 read as
         61) leaves the number sitting under its ORIGINAL column, so exactly
         one copy has xcol != n2col(value) — that is the misread one, and the
         column it was printed in names the decade it should have been.    */
      var suspect = opts.filter(function (o) {
        var xc = tickets[o.slot.ti]._xcol;
        return xc && xc[o.slot.i] >= 0 && xc[o.slot.i] !== n2col(v) && xc[o.slot.i] === n2col(o.mv);
      });
      if (suspect.length === 1) opts = suspect;
      else if (suspect.length === 0) {
        /* Second tell: a column is printed ascending downward. A units-digit
           misread (83 read as 88 above a printed 87) breaks that order, and
           putting the real number back restores it.                       */
        var byOrder = opts.filter(function (o) {
          var t = tickets[o.slot.ti], c = n2col(v);
          if (colAscending(t, c)) return false;                 // nothing wrong here
          var save = t.numbers.slice(), ok, q;
          t.numbers[o.slot.i] = null;
          t.numbers[o.target] = o.mv;
          ok = colAscending(t, c) && colAscending(t, n2col(o.mv));
          for (q = 0; q < 27; q++) t.numbers[q] = save[q];
          return ok;
        });
        if (byOrder.length === 1) opts = byOrder;
      }

      var viable = opts.filter(function (o) {
        var t = tickets[o.slot.ti], save = t.numbers.slice(), q;
        t.numbers[o.slot.i] = null;
        t.numbers[o.target] = o.mv;
        var st = buildState(tickets), miss = missingOf(tickets);
        var ok = freeSlots(st) === miss.length &&
          (existsSolution(st, miss, true) || existsSolution(st, miss, false));
        for (q = 0; q < 27; q++) t.numbers[q] = save[q];
        return ok;
      });
      if (viable.length !== 1) continue;
      var o = viable[0], t2 = tickets[o.slot.ti];
      t2.numbers[o.slot.i] = null;
      t2.numbers[o.target] = o.mv;
      if (t2._xcol) { t2._xcol[o.slot.i] = -1; t2._xcol[o.target] = n2col(o.mv); }
      missing.splice(missing.indexOf(o.mv), 1);
      slots[v].splice(slots[v].indexOf(o.slot), 1);
      applied++;
    }
    return applied;
  }

  /* Repair alternates between the two: correcting a misread frees a number
     that lets the solver deduce more holes, and vice versa.               */
  function repairSheet(sheet) {
    var tickets = sheet.tickets;
    if (tickets.length !== 6) { sortColumns(tickets); return 0; }
    var total = 0, deadline = Date.now() + BUDGET.repair;
    for (var pass = 0; pass < 6; pass++) {
      var a = fixConfusions(tickets, deadline);
      var b = fillMissing(tickets, deadline);
      total += a + b;
      if (!a && !b) break;
      if (Date.now() > deadline) break;
    }
    sortColumns(tickets);
    return total;
  }

  /* ── 11. SCORING ─────────────────────────────────────────────────────────
     This is what replaces per-organiser tuning: every hypothesis is judged by
     the rules of the game, and the best-scoring one wins.                  */
  function scoreSheets(sheets, poolSize) {
    var placed = 0, perfect = 0, bonus = 0, dups = 0, tickets = 0;
    sheets.forEach(function (sh) {
      var seen = {};
      sh.tickets.forEach(function (t) {
        tickets++;
        var c = 0, rows = [0, 0, 0];
        for (var i = 0; i < 27; i++) {
          if (t.numbers[i] === null) continue;
          c++; rows[Math.floor(i / 9)]++;
          seen[t.numbers[i]] = (seen[t.numbers[i]] || 0) + 1;
        }
        placed += c;
        if (c === 15 && rows[0] === 5 && rows[1] === 5 && rows[2] === 5) perfect++;
        bonus -= (t._issues ? t._issues.length : 0) * 2;
      });
      Object.keys(seen).forEach(function (k) { if (seen[k] > 1) dups += seen[k] - 1; });
      // full books of six: every number 1..90 exactly once
      for (var s = 0; s + 6 <= sh.tickets.length; s += 6) {
        var cnt = {}, ok = true, n;
        for (var q = s; q < s + 6; q++)
          sh.tickets[q].numbers.forEach(function (v) { if (v !== null) cnt[v] = (cnt[v] || 0) + 1; });
        for (n = 1; n <= 90; n++) if (cnt[n] !== 1) { ok = false; break; }
        if (ok) bonus += 60;
      }
    });
    return perfect * 12 + bonus - dups * 6 - Math.max(0, poolSize - placed) * 1.5
      - Math.abs(tickets * 15 - poolSize) * 0.25;
  }
  function allPerfect(sheets) {
    var any = false;
    for (var i = 0; i < sheets.length; i++) {
      for (var j = 0; j < sheets[i].tickets.length; j++) {
        var t = sheets[i].tickets[j], c = 0, rows = [0, 0, 0];
        for (var k = 0; k < 27; k++) if (t.numbers[k] !== null) { c++; rows[Math.floor(k / 9)]++; }
        if (c !== 15 || rows[0] !== 5 || rows[1] !== 5 || rows[2] !== 5) return false;
        any = true;
      }
    }
    return any;
  }

  /* ── 12. BUILD ONE HYPOTHESIS ────────────────────────────────────────── */
  function buildSheets(tokens, opt, ctx) {
    var consumed = new Set();

    // -- confident single/double digit numbers define the geometry
    var conf = [];
    for (var i = 0; i < tokens.length; i++) {
      var v = numValue(tokens[i].t);
      if (v !== null) { tokens[i].v = v; conf.push(tokens[i]); }
    }
    if (conf.length < 15) return null;

    // -- reject size outliers (giant watermarks, tiny footers)
    var mh = med(conf.map(function (t) { return t.h; })) || 10;
    if (opt.sizeGate) {
      var sized = conf.filter(function (t) { return t.h >= mh * 0.55 && t.h <= mh * 1.75; });
      if (sized.length >= 15) conf = sized;
    }

    /* -- rejoin digits OCR split apart ("1" "7" -> 17). A lone "0" is not a
       number on its own, so it never reaches the pool above — but it is the
       tail of 10, 20, 40, 80 … and has to be present for those to be rebuilt. */
    if (opt.glue) {
      var zeros = [];
      for (i = 0; i < tokens.length; i++) {
        var z = tokens[i];
        if (z.t !== '0') continue;
        if (opt.sizeGate && (z.h < mh * 0.55 || z.h > mh * 1.75)) continue;
        zeros.push(z);
      }
      conf = glueFragments(zeros.length ? conf.concat(zeros) : conf, mh)
        .filter(function (t) { return t.t !== '0'; });
      conf.forEach(function (t) { if (t.v == null) t.v = numValue(t.t); });
    }

    // -- reject anything off the number grid
    var grid = opt.gridGate ? buildXGrid(conf) : null;
    var nums = conf.filter(function (t) { return onGrid(grid, t.cx); });
    if (nums.length < 15) nums = conf;
    nums = nums.slice();
    nums.forEach(function (n) {
      consumed.add(n);
      if (n.src) n.src.forEach(function (s) { consumed.add(s); });
    });

    // -- rows
    var bands = bandRows(nums, opt.rowTol);

    /* -- rescue pass: some renderers glue two cells together ("2143").
       Only fires for a token sitting INSIDE a row that is short of a clean
       multiple of 5, and only if both halves land in free columns. This
       keeps ticket ids / sheet numbers / prices from being shredded.     */
    (function () {
      var rowTol = Math.max(mh * opt.rowTol, 2.5);
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
    if (!bands.length) return null;
    var rowPitch = bands.length > 1
      ? med(bands.slice(1).map(function (b, i) { return b.cy - bands[i].cy; })) : mh * 1.6;
    var groups = opt.groupMode === 'three' ? groupByThree(bands) : groupBands(bands, opt.grpGap);

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
      var perBand = segmentGroup(grp, k, opt.segMode);
      for (var s = 0; s < k; s++) {
        var rows = perBand.map(function (segs) { return segs[s] || []; });
        var flat = rows.reduce(function (a, r) { return a.concat(r); }, []);
        if (flat.length < 6) continue;
        var placedT = placeTicket(rows, colX);
        blocks.push({
          numbers: placedT.numbers,
          xcols: placedT.xcols,
          issues: placedT.issues,
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
    if (!blocks.length) return null;

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
    function sheetFor(block) {
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
      var sh = sheetFor(blocks[b]);
      var idTok = ids[b];
      var id = idTok ? idTok.t.replace(/[^\w\-]/g, '') : String(sh.tickets.length + 1);
      while (sh.tickets.some(function (t) { return t.id === id; })) id = id + '·';
      sh.tickets.push({ id: id, numbers: blocks[b].numbers, _xcol: blocks[b].xcols, _issues: blocks[b].issues, _count: blocks[b].count });
    }
    return { sheets: sheets, poolSize: nums.length, blocks: blocks.length, labels: labels.length, rowPitch: rowPitch };
  }

  /* ── 13. PAGE PARSE — search the hypotheses, keep the best ───────────────
     The first entry is the cheap default that fits most sheets; the search
     stops the moment a hypothesis produces nothing but perfect tickets, so
     well-behaved files cost exactly one pass.                             */
  var ROW_TOL  = [0.50, 0.35, 0.70, 0.95];
  var GRP_GAP  = [1.45, 1.25, 1.80, 2.40];
  var SEG_MODE = ['union', 'chunk', 'band'];

  function buildHypotheses() {
    var out = [{ rowTol: 0.50, grpGap: 1.45, segMode: 'union', groupMode: 'gap', gridGate: true, sizeGate: true, glue: true }];
    for (var q = 0; q < 2; q++)
      for (var g = 0; g < 2; g++)
        for (var z = 0; z < 2; z++)
          for (var r = 0; r < ROW_TOL.length; r++)
            for (var m = 0; m < SEG_MODE.length; m++) {
              for (var p = 0; p < GRP_GAP.length; p++)
                out.push({ rowTol: ROW_TOL[r], grpGap: GRP_GAP[p], segMode: SEG_MODE[m], groupMode: 'gap', gridGate: !g, sizeGate: !z, glue: !q });
              out.push({ rowTol: ROW_TOL[r], grpGap: 1.45, segMode: SEG_MODE[m], groupMode: 'three', gridGate: !g, sizeGate: !z, glue: !q });
            }
    return out;
  }
  var HYPOS = buildHypotheses();

  function parsePage(rawItems, ctx) {
    ctx = ctx || {};
    var tokens = tokenize(rawItems);
    if (!tokens.length) return { sheets: [], diag: { reason: 'no-tokens' } };
    if (needsRotation(tokens)) { tokens = rotateTokens(tokens); ctx.rotated = true; }

    var best = null, tried = 0, deadline = Date.now() + BUDGET.page;
    for (var i = 0; i < HYPOS.length; i++) {
      if (i > 0 && Date.now() > deadline) break;
      var fresh = tokens.map(function (t) {          // hypotheses must not share state
        return { t: t.t, x0: t.x0, x1: t.x1, y0: t.y0, y1: t.y1, cx: t.cx, cy: t.cy, w: t.w, h: t.h, vert: t.vert, est: t.est };
      });
      var r = buildSheets(fresh, HYPOS[i], ctx);
      tried++;
      if (!r) continue;
      var s = scoreSheets(r.sheets, r.poolSize);
      if (!best || s > best.score) best = { score: s, res: r, opt: HYPOS[i] };
      if (allPerfect(r.sheets)) break;               // cannot do better than this
    }
    if (!best) return { sheets: [], diag: { reason: 'no-blocks', tried: tried } };
    return {
      sheets: best.res.sheets,
      diag: {
        blocks: best.res.blocks, labels: best.res.labels, rowPitch: best.res.rowPitch,
        score: Math.round(best.score), tried: tried, rotated: !!ctx.rotated,
        hypothesis: best.opt.segMode + '/' + best.opt.rowTol + '/' +
          (best.opt.groupMode === 'three' ? 'fixed3' : best.opt.grpGap) +
          (best.opt.gridGate ? '' : '/nogrid') + (best.opt.sizeGate ? '' : '/nosize') +
          (best.opt.glue ? '' : '/noglue')
      }
    };
  }

  /* ── 14. PUBLIC ENTRY ────────────────────────────────────────────────── */
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
    ocrApiKey: 'helloworld',           // OCR.space's SHARED DEMO KEY — heavily
                                       // rate limited. Get a free personal key
                                       // at ocr.space/ocrapi and set it with
                                       // TBFiles.config({ocrApiKey:'…'}).
    ocrUrl: 'https://api.ocr.space/parse/image',
    ocrEngine: 2,
    ocrEngineFallback: 1,              // retry with engine 1 if 2 reads thin
    ocrScale: 3.0,                     // render scale for scanned PDF pages
    ocrTargetPx: 2200,                 // long edge to normalise images to
    ocrMaxBytes: 1000 * 1024,          // free-tier upload ceiling
    maxOcrPages: 12
  };
  function config(o) {
    for (var k in o) {
      if (!o.hasOwnProperty(k)) continue;
      if (k === 'pageBudgetMs') BUDGET.page = o[k];
      else if (k === 'repairBudgetMs') BUDGET.repair = o[k];
      else CFG[k] = o[k];
    }
  }

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
     item.transform maps text space to PDF space; the viewport transform then
     flips into screen space (y down). item.width / item.height are ALREADY in
     page units — they must NOT be multiplied by the matrix scale again. The
     box is the axis-aligned hull of the glyph run's four corners, so sideways
     text (sheet labels, ticket ids) measures correctly too.               */
  function pdfPageItems(page) {
    return page.getTextContent().then(function (tc) {
      var vp = page.getViewport({ scale: 1 });
      var U = (root.pdfjsLib && root.pdfjsLib.Util) || null;
      var out = [];
      for (var i = 0; i < tc.items.length; i++) {
        var it = tc.items[i];
        if (!it.str || !it.str.trim()) continue;
        var m = U ? U.transform(vp.transform, it.transform) : it.transform;
        var au = Math.hypot(m[0], m[1]) || 1;      // advance-direction magnitude
        var vu = Math.hypot(m[2], m[3]) || 1;      // ascent-direction magnitude
        var ux = m[0] / au, uy = m[1] / au;
        var vx = m[2] / vu, vy = m[3] / vu;
        var h = it.height || 0; if (!h) h = vu || 10;
        var w = it.width || 0;  if (!w) w = h * 0.6 * it.str.length;
        var ox = m[4], oy = m[5];                  // baseline origin, screen space
        var xs = [ox, ox + ux * w, ox + vx * h, ox + ux * w + vx * h];
        var ys = [oy, oy + uy * w, oy + vy * h, oy + uy * w + vy * h];
        var vert = Math.abs(ux) < Math.abs(uy);
        out.push({
          str: it.str,
          x: Math.min.apply(null, xs), y: Math.min.apply(null, ys),
          w: Math.max.apply(null, xs) - Math.min.apply(null, xs),
          h: Math.max.apply(null, ys) - Math.min.apply(null, ys),
          vert: vert,
          dir: vert ? (uy >= 0 ? 1 : -1) : (ux >= 0 ? 1 : -1)
        });
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

  /* ── is this PDF really just a photo? ────────────────────────────────────
     Plenty of organisers "make a PDF" by dropping a screenshot or a phone
     photo of the sheet into one. The file says .pdf but carries no text at
     all — only a bitmap. That is worth naming exactly, because the fix is
     not on our side: the original PDF exists, the sender just did not send
     it. Only asked when the text layer already came back too thin, so a
     normal file never pays for the operator-list scan.                    */
  function countNumberItems(pages) {
    var n = 0;
    (pages || []).forEach(function (items) {
      items.forEach(function (it) {
        String(it.str).trim().split(/\s+/).forEach(function (w) {
          if (numValue(w) !== null) n++;
        });
      });
    });
    return n;
  }
  function pdfHasBitmap(pdf) {
    var OPS = (root.pdfjsLib && root.pdfjsLib.OPS) || null;
    if (!OPS) return Promise.resolve(false);
    var paintOps = [];
    Object.keys(OPS).forEach(function (k) { if (/^paint.*Image/i.test(k)) paintOps.push(OPS[k]); });
    if (!paintOps.length) return Promise.resolve(false);
    var n = Math.min(pdf.numPages, 3), chain = Promise.resolve(), found = false;
    for (var p = 1; p <= n; p++) {
      (function (i) {
        chain = chain.then(function () {
          if (found) return null;
          return pdf.getPage(i).then(function (pg) { return pg.getOperatorList(); })
            .then(function (ops) {
              for (var k = 0; k < ops.fnArray.length; k++)
                if (paintOps.indexOf(ops.fnArray[k]) >= 0) { found = true; return; }
            }).catch(function () { });
        });
      })(p);
    }
    return chain.then(function () { return found; });
  }

  /* ── OCR ▸ token boxes (OCR.space overlay) ───────────────────────────── */
  function ocrOnce(blob, filename, engine) {
    var fd = new FormData();
    fd.append('file', blob, filename || 'page.png');
    fd.append('apikey', CFG.ocrApiKey);
    fd.append('isOverlayRequired', 'true');
    fd.append('OCREngine', String(engine));
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
  /* how many usable ticket numbers did a page of OCR boxes yield? */
  function numYield(pages) {
    var n = 0;
    (pages || []).forEach(function (items) {
      items.forEach(function (it) {
        String(it.str).split(/\s+/).forEach(function (w) { if (numValue(w) !== null) n++; });
      });
    });
    return n;
  }
  /* Engine 2 reads clean digits best; engine 1 copes better with noisy scans.
     Try one, and only pay for the other if the first came back thin.      */
  function ocrBlob(blob, filename) {
    return ocrOnce(blob, filename, CFG.ocrEngine).then(function (p1) {
      if (numYield(p1) >= 80 || !CFG.ocrEngineFallback) return p1;
      return ocrOnce(blob, filename, CFG.ocrEngineFallback).then(function (p2) {
        return numYield(p2) > numYield(p1) ? p2 : p1;
      }).catch(function () { return p1; });
    });
  }

  /* ── canvas helpers ── */
  function canvasToBlob(cv, bytesLimit) {
    return new Promise(function (res) {
      cv.toBlob(function (b) {
        if (!b || !bytesLimit || b.size <= bytesLimit) return res(b);
        cv.toBlob(function (b2) { res(b2 && b2.size < b.size ? b2 : b); }, 'image/jpeg', 0.82);
      }, 'image/jpeg', 0.94);
    });
  }

  /* ── render a PDF page to an image so it can be OCR'd ── */
  function pageToBlob(page) {
    var vp = page.getViewport({ scale: CFG.ocrScale });
    var cv = document.createElement('canvas');
    cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
      return canvasToBlob(cv, CFG.ocrMaxBytes);
    });
  }

  /* ── normalise a photographed / scanned image before OCR ────────────────
     Organisers send everything from crisp exports to phone photos. Scaling
     the long edge to a known size and stretching contrast makes small or
     washed-out digits legible without any per-file tuning.                */
  function loadImage(file) {
    if (root.createImageBitmap) {
      return root.createImageBitmap(file).catch(function () { return loadImageEl(file); });
    }
    return loadImageEl(file);
  }
  function loadImageEl(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); res(img); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('Could not read image')); };
      img.src = url;
    });
  }
  function prepImage(file) {
    return loadImage(file).then(function (img) {
      var iw = img.width || img.naturalWidth, ih = img.height || img.naturalHeight;
      if (!iw || !ih) throw new Error('Could not read image');
      var scale = CFG.ocrTargetPx / Math.max(iw, ih);
      scale = Math.max(0.35, Math.min(scale, 4));
      var cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(iw * scale));
      cv.height = Math.max(1, Math.round(ih * scale));
      var ctx = cv.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      try { stretchContrast(ctx, cv.width, cv.height); } catch (e) { /* tainted canvas: skip */ }
      return canvasToBlob(cv, CFG.ocrMaxBytes);
    });
  }
  /* grayscale + 2% / 98% percentile contrast stretch */
  function stretchContrast(ctx, w, h) {
    var img = ctx.getImageData(0, 0, w, h), d = img.data, hist = new Uint32Array(256), i;
    for (i = 0; i < d.length; i += 4) {
      var g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      d[i] = d[i + 1] = d[i + 2] = g;
      hist[g]++;
    }
    var total = w * h, lo = 0, hi = 255, acc = 0;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc > total * 0.02) { lo = i; break; } }
    acc = 0;
    for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc > total * 0.02) { hi = i; break; } }
    if (hi - lo < 24) return;                       // already flat: leave alone
    var lut = new Uint8Array(256);
    for (i = 0; i < 256; i++) lut[i] = Math.max(0, Math.min(255, Math.round((i - lo) * 255 / (hi - lo))));
    for (i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = lut[d[i]]; }
    ctx.putImageData(img, 0, 0);
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

  /* A .pdf that is only a picture of a sheet. Named as its own failure so the
     UI can say what to do about it instead of "could not read this file".  */
  var SCAN_MSG = 'This PDF is a picture of the sheet, not a real PDF — some numbers could not be read from the image';
  function scanError(fname) {
    var e = new Error((fname ? fname + ': ' : '') +
      'this file is a photo or screenshot saved as a PDF, so it has no readable numbers in it. ' +
      'Ask the organiser for the original PDF (the one their ticket software produced).');
    e.code = 'image-pdf';
    e.file = fname || '';
    return e;
  }
  function imageError(fname) {
    var e = new Error((fname ? fname + ': ' : '') +
      'could not read the numbers out of this image. A PDF from the organiser reads perfectly; ' +
      'a photo only works if the whole sheet is flat, sharp and evenly lit.');
    e.code = 'image-unreadable';
    e.file = fname || '';
    return e;
  }

  /* ── MAIN ENTRY ─────────────────────────────────────────────────────────
     Returns { sheets, method, imageOnly, diag, warnings }                 */
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

    // Images — normalise, then OCR
    if (/\.(jpe?g|png|webp|bmp|gif|tiff?|heic|heif)$/.test(name) || /^image\//.test(file.type || '')) {
      return prepImage(file).catch(function () { return file; })
        .then(function (blob) { return ocrBlob(blob, file.name || 'sheet.jpg'); })
        .then(function (pages) {
          var r = parsePages(pages, base);
          var s = score(r.sheets);
          if (!s.good) throw imageError(file.name);
          return {
            sheets: toAppSheets(r.sheets), method: 'ocr-image', imageOnly: true, diag: r.diag,
            warnings: s.ratio < 0.999 ? ['read from an image — please check the numbers'] : []
          };
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
        // Nothing readable in the text layer: decide WHY before falling back,
        // so a scan can be named as a scan instead of "could not read".
        var thin = countNumberItems(res.pages) < 15;
        return (thin ? pdfHasBitmap(res.pdf) : Promise.resolve(false)).then(function (isScan) {
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
            var warnings = [];
            if (isScan) {
              // OCR got everything -> quietly fine. Anything less is worth saying
              // plainly, because the real fix is to send the original PDF.
              if (!s2.total || s2.ratio < 0.999) warnings.push(SCAN_MSG);
            } else if (s1.total && s1.ratio < 1 && !useOcr) {
              warnings.push('partial text layer');
            }
            if (isScan && !s2.good) throw scanError(file.name);
            return {
              sheets: toAppSheets(chosen.sheets),
              method: useOcr ? 'pdf-ocr' : 'pdf-text',
              imageOnly: isScan,
              diag: chosen.diag,
              warnings: warnings
            };
          }).catch(function (e) {
            if (e && e.code === 'image-pdf') throw e;
            if (isScan) throw scanError(file.name);
            if (s1.total) {
              return {
                sheets: toAppSheets(textRun.sheets), method: 'pdf-text',
                diag: textRun.diag, warnings: ['OCR fallback failed: ' + e.message]
              };
            }
            throw e;
          });
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

  /* ── report card for the UI ──────────────────────────────────────────────
     Two kinds of problem. A ticket can be short (rows or numbers missing),
     or a sheet of six can fail the 1..90 check while every ticket looks fine
     on its own — that is what a digit misread looks like, and it is the one
     failure that would otherwise play silently wrong.                     */
  function inspect(sheets) {
    var bad = [], index = {};
    function note(sh, t, reason) {
      var key = sh.name + ' ' + t.id, row = index[key];
      if (row) {                                  // one row per ticket, reasons merged
        if (row.reason.indexOf(reason) < 0) row.reason += ' · ' + reason;
        return;
      }
      var nums = t.numbers.filter(function (v) { return v !== null; });
      var rows = [0, 1, 2].map(function (r) {
        return t.numbers.slice(r * 9, r * 9 + 9).filter(function (v) { return v !== null; }).length;
      });
      row = {
        sheetName: sh.name, ticketId: t.id,
        rows: rows.filter(function (r) { return r > 0; }).length,
        count: nums.length, nums: nums, reason: reason
      };
      index[key] = row; bad.push(row);
    }
    sheets.forEach(function (sh) {
      var seen = {};
      sh.tickets.forEach(function (t) {
        var nums = t.numbers.filter(function (n) { return n !== null; });
        var rows = [0, 1, 2].map(function (r) {
          return t.numbers.slice(r * 9, r * 9 + 9).filter(function (n) { return n !== null; }).length;
        });
        nums.forEach(function (n) { seen[n] = (seen[n] || 0) + 1; });
        if (nums.length !== 15 || rows.some(function (r) { return r !== 5; })) {
          note(sh, t, rows.filter(function (r) { return r > 0; }).length + '/3 rows · ' + nums.length + '/15 numbers found');
        }
      });
      /* Tickets come in books of six holding 1..90 exactly once. A page may
         carry more than one book, so each block of six is checked on its own
         — lumping twelve together would read every number as a duplicate. */
      var parts = [];
      if (sh.tickets.length % 6 !== 0) {
        parts.push('only ' + sh.tickets.length + ' of 6 tickets read');
      } else {
        for (var s = 0; s + 6 <= sh.tickets.length && !parts.length; s += 6) {
          var cnt = {}, dups = [], missing = [], n, q;
          for (q = s; q < s + 6; q++)
            sh.tickets[q].numbers.forEach(function (v) { if (v !== null) cnt[v] = (cnt[v] || 0) + 1; });
          for (n = 1; n <= 90; n++) {
            if (!cnt[n]) missing.push(n);
            else if (cnt[n] > 1) dups.push(n);
          }
          if (dups.length) parts.push(dups.join(', ') + ' read twice');
          if (missing.length) parts.push(missing.join(', ') + ' missing');
        }
      }
      if (!parts.length) return;
      var reason = 'sheet check failed — ' + parts.join('; ');
      sh.tickets.forEach(function (t) { note(sh, t, reason); });
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
