/* Round-trip check: encode a string, then read it back out of the finished
   matrix the way a scanner would (format info -> unmask -> zigzag -> blocks).
   Catches placement, masking, interleaving and format-info errors. */
load("web/js/qr.js");

var SPEC = {
  1:[10,1,16,0,0], 2:[16,1,28,0,0], 3:[26,1,44,0,0],  4:[18,2,32,0,0],  5:[24,2,43,0,0],
  6:[16,4,27,0,0], 7:[18,4,31,0,0], 8:[22,2,38,2,39], 9:[22,3,36,2,37], 10:[26,4,43,1,44]
};
var ALIGN = {
  1:[], 2:[6,18], 3:[6,22], 4:[6,26], 5:[6,30],
  6:[6,34], 7:[6,22,38], 8:[6,24,42], 9:[6,26,46], 10:[6,28,50]
};
function maskFn(n, r, c) {
  switch (n) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r/2) + Math.floor(c/3)) % 2 === 0;
    case 5: return (r*c) % 2 + (r*c) % 3 === 0;
    case 6: return ((r*c) % 2 + (r*c) % 3) % 2 === 0;
    default: return ((r + c) % 2 + (r*c) % 3) % 2 === 0;
  }
}
// independently mark which cells are function/reserved (not data)
function reserved(version) {
  var size = version * 4 + 17, g = [], r, c;
  for (r = 0; r < size; r++) { g.push([]); for (c = 0; c < size; c++) g[r].push(false); }
  function box(r0, c0, h, w) {
    for (var i = r0; i < r0 + h; i++) for (var j = c0; j < c0 + w; j++)
      if (i >= 0 && j >= 0 && i < size && j < size) g[i][j] = true;
  }
  box(0,0,9,9); box(0,size-8,9,8); box(size-8,0,8,9);          // finders + format
  for (var i = 0; i < size; i++) { g[6][i] = true; g[i][6] = true; }   // timing
  var ac = ALIGN[version];
  for (i = 0; i < ac.length; i++) for (var j = 0; j < ac.length; j++) {
    var ar = ac[i], acc = ac[j];
    if ((ar <= 8 && acc <= 8) || (ar <= 8 && acc >= size-9) || (ar >= size-9 && acc <= 8)) continue;
    box(ar-2, acc-2, 5, 5);
  }
  if (version >= 7) { box(size-11,0,3,6); box(0,size-11,6,3); }
  return g;
}

function decode(qr) {
  var m = qr.modules, size = qr.size, version = (size - 17) / 4;
  // --- read format info (top-left copy) and recover the mask ---
  var bits = 0, i;
  for (i = 0; i <= 5; i++) bits |= m[8][i] << i;
  bits |= m[8][7] << 6; bits |= m[8][8] << 7; bits |= m[7][8] << 8;
  for (i = 9; i <= 14; i++) bits |= m[14 - i][8] << i;
  var fmt = bits ^ 0x5412;
  var ecLevel = (fmt >>> 13) & 3, mask = (fmt >>> 10) & 7;
  if (ecLevel !== 0) throw new Error("expected ECC level M, got " + ecLevel);

  // --- unmask data cells ---
  var res = reserved(version), g = [], r, c;
  for (r = 0; r < size; r++) { g.push([]); for (c = 0; c < size; c++)
    g[r].push(res[r][c] ? m[r][c] : (m[r][c] ^ (maskFn(mask, r, c) ? 1 : 0))); }

  // --- read codewords in zigzag ---
  var bitsOut = [], up = true;
  for (var right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (var v = 0; v < size; v++) {
      var row = up ? size - 1 - v : v;
      for (var k = 0; k < 2; k++) {
        var col = right - k;
        if (res[row][col]) continue;
        bitsOut.push(g[row][col]);
      }
    }
    up = !up;
  }
  var cw = [];
  for (i = 0; i + 8 <= bitsOut.length; i += 8) {
    var b = 0; for (var j = 0; j < 8; j++) b = (b << 1) | bitsOut[i + j];
    cw.push(b);
  }
  // --- de-interleave data codewords back into blocks ---
  var s = SPEC[version], blocks = [], sizes = [];
  for (i = 0; i < s[1]; i++) sizes.push(s[2]);
  for (i = 0; i < s[3]; i++) sizes.push(s[4]);
  for (i = 0; i < sizes.length; i++) blocks.push([]);
  var maxD = Math.max.apply(null, sizes), idx = 0;
  for (i = 0; i < maxD; i++)
    for (j = 0; j < blocks.length; j++)
      if (i < sizes[j]) blocks[j].push(cw[idx++]);
  var data = [];
  for (i = 0; i < blocks.length; i++) data = data.concat(blocks[i]);

  // --- parse byte-mode payload ---
  var bb = [];
  for (i = 0; i < data.length; i++) for (j = 7; j >= 0; j--) bb.push((data[i] >>> j) & 1);
  function take(n) { var x = 0; for (var q = 0; q < n; q++) x = (x << 1) | bb.shift(); return x; }
  var mode = take(4);
  if (mode !== 4) throw new Error("expected byte mode (4), got " + mode);
  var len = take(version < 10 ? 8 : 16);
  var out = "";
  for (i = 0; i < len; i++) out += "%" + ("0" + take(8).toString(16)).slice(-2);
  return decodeURIComponent(out);
}

var cases = [
  "https://quizzer-ux0t.onrender.com",
  "https://quizzer-ux0t.onrender.com/play.html",
  "A",
  "http://192.168.1.9:8000/play.html?code=ABCDE",
  "x".repeat(100)
];
var fails = 0;
cases.forEach(function (t) {
  try {
    var qr = QR.encode(t);
    var back = decode(qr);
    var ok = back === t;
    if (!ok) fails++;
    print((ok ? "  PASS " : "  FAIL ") + "v" + qr.version + " " + qr.size + "x" + qr.size +
          "  " + JSON.stringify(t.length > 42 ? t.slice(0, 42) + "..." : t) +
          (ok ? "" : "  -> got " + JSON.stringify(back.slice(0, 50))));
  } catch (e) { fails++; print("  FAIL " + JSON.stringify(t.slice(0,42)) + " -> " + e.message); }
});

// structural sanity on the real URL
var q = QR.encode("https://quizzer-ux0t.onrender.com");
function finderOK(r, c) {
  var m = q.modules;
  return m[r][c] === 1 && m[r+1][c+1] === 0 && m[r+3][c+3] === 1 && m[r+6][c+6] === 1;
}
var struct = finderOK(0,0) && finderOK(0,q.size-7) && finderOK(q.size-7,0);
print((struct ? "  PASS " : "  FAIL ") + "three finder patterns well-formed");
if (!struct) fails++;
var timing = true;
for (var i = 8; i < q.size - 8; i++) if (q.modules[6][i] !== (i % 2 === 0 ? 1 : 0)) timing = false;
print((timing ? "  PASS " : "  FAIL ") + "horizontal timing pattern alternates");
if (!timing) fails++;

print(fails === 0 ? "\nQR ROUND-TRIP PASSED" : "\n" + fails + " QR FAILURES");
