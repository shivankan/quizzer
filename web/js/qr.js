/* Minimal QR Code encoder (byte mode, ECC level M, versions 1-10).
   Self-contained so the login page needs no QR service or CDN. */
(function (global) {
  "use strict";

  // ---- GF(256), primitive polynomial 0x11D ----
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    for (var x = 1, i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1; if (x & 0x100) x ^= 0x11D;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function mul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  // generator polynomial for n EC codewords
  function genPoly(n) {
    var p = [1];
    for (var i = 0; i < n; i++) {
      var q = p.concat([0]);
      for (var j = 0; j < p.length; j++) q[j + 1] ^= mul(p[j], EXP[i]);
      p = q;
    }
    return p;
  }

  function ecBytes(data, n) {
    var g = genPoly(n), rem = new Array(n).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ rem[0];
      rem.shift(); rem.push(0);
      for (var j = 0; j < n; j++) rem[j] ^= mul(g[j + 1], factor);
    }
    return rem;
  }

  // ---- ECC level M block structure: [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] ----
  var SPEC = {
    1:[10,1,16,0,0], 2:[16,1,28,0,0], 3:[26,1,44,0,0],  4:[18,2,32,0,0],  5:[24,2,43,0,0],
    6:[16,4,27,0,0], 7:[18,4,31,0,0], 8:[22,2,38,2,39], 9:[22,3,36,2,37], 10:[26,4,43,1,44]
  };
  var ALIGN = {
    1:[], 2:[6,18], 3:[6,22], 4:[6,26], 5:[6,30],
    6:[6,34], 7:[6,22,38], 8:[6,24,42], 9:[6,26,46], 10:[6,28,50]
  };
  function dataCapacity(v) { var s = SPEC[v]; return s[1] * s[2] + s[3] * s[4]; }

  function chooseVersion(byteLen) {
    for (var v = 1; v <= 10; v++) {
      var lenBits = v < 10 ? 8 : 16;          // byte mode char-count bits
      var need = Math.ceil((4 + lenBits + byteLen * 8) / 8);
      if (need <= dataCapacity(v)) return v;
    }
    throw new Error("Content too long for this QR encoder");
  }

  // ---- bit buffer ----
  function Bits() { this.bits = []; }
  Bits.prototype.put = function (val, len) {
    for (var i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  };

  function encodeData(bytes, version) {
    var cap = dataCapacity(version), bb = new Bits();
    bb.put(4, 4);                                   // byte mode
    bb.put(bytes.length, version < 10 ? 8 : 16);
    for (var i = 0; i < bytes.length; i++) bb.put(bytes[i], 8);
    var capBits = cap * 8;
    bb.put(0, Math.min(4, capBits - bb.bits.length));   // terminator
    while (bb.bits.length % 8) bb.bits.push(0);
    var cw = [];
    for (var k = 0; k < bb.bits.length; k += 8) {
      var b = 0;
      for (var m = 0; m < 8; m++) b = (b << 1) | bb.bits[k + m];
      cw.push(b);
    }
    var pad = [0xEC, 0x11], p = 0;
    while (cw.length < cap) cw.push(pad[p++ % 2]);
    return cw;
  }

  // split into blocks, append EC, interleave
  function interleave(cw, version) {
    var s = SPEC[version], ecLen = s[0];
    var blocks = [], ecs = [], at = 0, i;
    for (i = 0; i < s[1]; i++) { blocks.push(cw.slice(at, at + s[2])); at += s[2]; }
    for (i = 0; i < s[3]; i++) { blocks.push(cw.slice(at, at + s[4])); at += s[4]; }
    for (i = 0; i < blocks.length; i++) ecs.push(ecBytes(blocks[i], ecLen));
    var out = [], maxD = Math.max(s[2], s[4] || 0), j;
    for (i = 0; i < maxD; i++)
      for (j = 0; j < blocks.length; j++)
        if (i < blocks[j].length) out.push(blocks[j][i]);
    for (i = 0; i < ecLen; i++)
      for (j = 0; j < ecs.length; j++) out.push(ecs[j][i]);
    return out;
  }

  // ---- matrix ----
  function makeMatrix(version) {
    var size = version * 4 + 17, m = [], r;
    for (r = 0; r < size; r++) m.push(new Array(size).fill(null));
    return m;
  }

  function placeFinder(m, r, c) {
    for (var i = -1; i <= 7; i++)
      for (var j = -1; j <= 7; j++) {
        var rr = r + i, cc = c + j;
        if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
        var on = (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
                 (j >= 0 && j <= 6 && (i === 0 || i === 6)) ||
                 (i >= 2 && i <= 4 && j >= 2 && j <= 4);
        m[rr][cc] = on ? 1 : 0;
      }
  }

  function placeFunctions(m, version) {
    var size = m.length, i, j;
    placeFinder(m, 0, 0); placeFinder(m, 0, size - 7); placeFinder(m, size - 7, 0);
    for (i = 8; i < size - 8; i++) {           // timing
      var bit = (i % 2 === 0) ? 1 : 0;
      m[6][i] = bit; m[i][6] = bit;
    }
    var ac = ALIGN[version];                   // alignment
    for (i = 0; i < ac.length; i++)
      for (j = 0; j < ac.length; j++) {
        var ar = ac[i], acc = ac[j];
        if (m[ar][acc] !== null) continue;     // skip finder overlaps
        for (var dr = -2; dr <= 2; dr++)
          for (var dc = -2; dc <= 2; dc++)
            m[ar + dr][acc + dc] =
              (Math.max(Math.abs(dr), Math.abs(dc)) !== 1) ? 1 : 0;
      }
    m[size - 8][8] = 1;                        // dark module
    // reserve format areas (filled later)
    for (i = 0; i <= 8; i++) {
      if (m[8][i] === null) m[8][i] = 0;
      if (m[i][8] === null) m[i][8] = 0;
    }
    for (i = 0; i < 8; i++) {
      if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 0;
      if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 0;
    }
    if (version >= 7) {                        // reserve version info
      for (i = 0; i < 6; i++)
        for (j = 0; j < 3; j++) {
          m[size - 11 + j][i] = 0; m[i][size - 11 + j] = 0;
        }
    }
  }

  function reservedMask(version) {             // true where data may NOT go
    var m = makeMatrix(version);
    placeFunctions(m, version);
    var res = [], size = m.length;
    for (var r = 0; r < size; r++) {
      res.push([]);
      for (var c = 0; c < size; c++) res[r].push(m[r][c] !== null);
    }
    return res;
  }

  function placeData(m, reserved, cw) {
    var size = m.length, bitIdx = 0, up = true;
    for (var right = size - 1; right > 0; right -= 2) {
      if (right === 6) right = 5;              // skip vertical timing column
      for (var v = 0; v < size; v++) {
        var row = up ? size - 1 - v : v;
        for (var k = 0; k < 2; k++) {
          var col = right - k;
          if (reserved[row][col]) continue;
          var bit = 0;
          if (bitIdx < cw.length * 8)
            bit = (cw[bitIdx >> 3] >>> (7 - (bitIdx & 7))) & 1;
          m[row][col] = bit; bitIdx++;
        }
      }
      up = !up;
    }
  }

  function maskFn(n, r, c) {
    switch (n) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return (r * c) % 2 + (r * c) % 3 === 0;
      case 6: return ((r * c) % 2 + (r * c) % 3) % 2 === 0;
      default: return ((r + c) % 2 + (r * c) % 3) % 2 === 0;
    }
  }

  function applyMask(m, reserved, n) {
    for (var r = 0; r < m.length; r++)
      for (var c = 0; c < m.length; c++)
        if (!reserved[r][c] && maskFn(n, r, c)) m[r][c] ^= 1;
  }

  // format info: 5 data bits (ECC M = 00 + mask) + BCH(15,5), XOR 0x5412
  function formatBits(mask) {
    var data = (0x00 << 3) | mask;             // 00 = level M
    var v = data << 10;
    for (var i = 4; i >= 0; i--)
      if ((v >>> (i + 10)) & 1) v ^= 0x537 << i;
    return ((data << 10) | v) ^ 0x5412;
  }

  function placeFormat(m, mask) {
    var size = m.length, bits = formatBits(mask), i;
    for (i = 0; i <= 5; i++) m[8][i] = (bits >>> i) & 1;
    m[8][7] = (bits >>> 6) & 1;
    m[8][8] = (bits >>> 7) & 1;
    m[7][8] = (bits >>> 8) & 1;
    for (i = 9; i <= 14; i++) m[14 - i][8] = (bits >>> i) & 1;
    for (i = 0; i <= 7; i++) m[size - 1 - i][8] = (bits >>> i) & 1;
    for (i = 8; i <= 14; i++) m[8][size - 15 + i] = (bits >>> i) & 1;
    m[size - 8][8] = 1;                        // dark module stays set
  }

  // version info: BCH(18,6) for versions >= 7
  function versionBits(version) {
    var v = version << 12;
    for (var i = 5; i >= 0; i--)
      if ((v >>> (i + 12)) & 1) v ^= 0x1F25 << i;
    return (version << 12) | v;
  }

  function placeVersion(m, version) {
    if (version < 7) return;
    var size = m.length, bits = versionBits(version);
    for (var i = 0; i < 18; i++) {
      var bit = (bits >>> i) & 1, r = Math.floor(i / 3), c = i % 3;
      m[size - 11 + c][r] = bit;
      m[r][size - 11 + c] = bit;
    }
  }

  function penalty(m) {
    var size = m.length, score = 0, r, c, i, run, dark = 0;
    for (r = 0; r < size; r++) {               // rule 1: runs in rows/cols
      run = 1;
      for (c = 1; c < size; c++) {
        if (m[r][c] === m[r][c - 1]) { run++; } else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (c = 0; c < size; c++) {
      run = 1;
      for (r = 1; r < size; r++) {
        if (m[r][c] === m[r - 1][c]) { run++; } else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (r = 0; r < size - 1; r++)             // rule 2: 2x2 blocks
      for (c = 0; c < size - 1; c++) {
        var a = m[r][c];
        if (a === m[r][c + 1] && a === m[r + 1][c] && a === m[r + 1][c + 1]) score += 3;
      }
    var pat = [1,0,1,1,1,0,1,0,0,0,0];         // rule 3: finder-like 1:1:3:1:1 + quiet
    var rpat = pat.slice().reverse();
    function match(arr, at, p) {
      for (var k = 0; k < p.length; k++) if (arr[at + k] !== p[k]) return false;
      return true;
    }
    for (r = 0; r < size; r++) {
      var rowArr = m[r], colArr = [];
      for (i = 0; i < size; i++) colArr.push(m[i][r]);
      for (c = 0; c + 11 <= size; c++) {
        if (match(rowArr, c, pat) || match(rowArr, c, rpat)) score += 40;
        if (match(colArr, c, pat) || match(colArr, c, rpat)) score += 40;
      }
    }
    for (r = 0; r < size; r++)                 // rule 4: dark/light balance
      for (c = 0; c < size; c++) if (m[r][c]) dark++;
    var pct = dark * 100 / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  function utf8Bytes(str) {
    var out = [], s = encodeURIComponent(str);
    for (var i = 0; i < s.length; i++) {
      if (s[i] === "%") { out.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
      else out.push(s.charCodeAt(i));
    }
    return out;
  }

  /** Returns { size, modules } where modules[r][c] is 1 (dark) or 0. */
  function encode(text) {
    var bytes = utf8Bytes(text);
    var version = chooseVersion(bytes.length);
    var cw = interleave(encodeData(bytes, version), version);
    var reserved = reservedMask(version);
    var best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var m = makeMatrix(version);
      placeFunctions(m, version);
      placeData(m, reserved, cw);
      applyMask(m, reserved, mask);
      placeFormat(m, mask);
      placeVersion(m, version);
      var sc = penalty(m);
      if (sc < bestScore) { bestScore = sc; best = m; }
    }
    return { size: best.length, modules: best, version: version };
  }

  /** Render into a container as a crisp canvas. */
  function render(container, text, opts) {
    opts = opts || {};
    var qr = encode(text);
    var quiet = opts.quiet == null ? 4 : opts.quiet;
    var px = opts.scale || 6;
    var total = (qr.size + quiet * 2) * px;
    var cv = document.createElement("canvas");
    cv.width = cv.height = total;
    cv.style.width = cv.style.height = (opts.cssSize || total) + "px";
    cv.setAttribute("role", "img");
    cv.setAttribute("aria-label", opts.label || ("QR code for " + text));
    var g = cv.getContext("2d");
    g.fillStyle = opts.light || "#ffffff";
    g.fillRect(0, 0, total, total);
    g.fillStyle = opts.dark || "#000000";
    for (var r = 0; r < qr.size; r++)
      for (var c = 0; c < qr.size; c++)
        if (qr.modules[r][c]) g.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
    container.innerHTML = "";
    container.appendChild(cv);
    return qr;
  }

  global.QR = { encode: encode, render: render };
})(typeof window !== "undefined" ? window : this);
