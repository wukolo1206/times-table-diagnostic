/* fact-chart.js — 極簡 SVG 圖表
 *
 * 不引入任何外部套件：學校網路可能擋 CDN，而且離線也要能看。
 * 只做這個專案需要的兩種圖，不做通用圖表庫。
 *
 * 產生的是 SVG 字串，呼叫端自己塞進 innerHTML。
 */
(function (root) {
  'use strict';

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function niceMax(v) {
    if (v <= 0) return 10;
    var step = Math.pow(10, Math.floor(Math.log(v) / Math.LN10)) / 2;
    return Math.ceil(v / step) * step;
  }

  /**
   * 折線圖。points: [{ label, value, tip }]
   * opts: { height, color, unit, minPoints }
   *
   * 只有一個點時不畫線只畫點——一條線需要兩個點才有「趨勢」的意義。
   */
  function line(points, opts) {
    opts = opts || {};
    var W = 100, H = opts.height || 46;          // viewBox 用相對單位，寬度自適應
    var pad = { l: 9, r: 3, t: 5, b: 9 };
    if (!points.length) return '';

    var max = niceMax(Math.max.apply(null, points.map(function (p) { return p.value; })));
    var color = opts.color || '#3f7d8c';
    var n = points.length;
    var innerW = W - pad.l - pad.r, innerH = H - pad.t - pad.b;

    function px(i) { return pad.l + (n === 1 ? innerW / 2 : innerW * i / (n - 1)); }
    function py(v) { return pad.t + innerH * (1 - (max ? v / max : 0)); }

    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart" ' +
            'preserveAspectRatio="none" role="img">';

    // 基準線：最大值與一半，讓眼睛有比例感
    [max, max / 2, 0].forEach(function (v) {
      s += '<line x1="' + pad.l + '" y1="' + py(v) + '" x2="' + (W - pad.r) +
           '" y2="' + py(v) + '" class="grid"/>';
      s += '<text x="' + (pad.l - 1) + '" y="' + (py(v) + 1.6) +
           '" class="ylab">' + Math.round(v) + '</text>';
    });

    if (n > 1) {
      var d = points.map(function (p, i) {
        return (i ? 'L' : 'M') + px(i).toFixed(2) + ' ' + py(p.value).toFixed(2);
      }).join(' ');
      s += '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="0.8"/>';
    }

    points.forEach(function (p, i) {
      s += '<circle cx="' + px(i).toFixed(2) + '" cy="' + py(p.value).toFixed(2) +
           '" r="1.5" fill="' + color + '"><title>' + esc(p.tip || p.label) + '</title></circle>';
      s += '<text x="' + px(i).toFixed(2) + '" y="' + (H - 1) +
           '" class="xlab">' + esc(p.label) + '</text>';
    });

    return s + '</svg>';
  }

  /** 長條圖。資料少的時候比折線好讀（例如只有三場）。 */
  function bars(points, opts) {
    opts = opts || {};
    var W = 100, H = opts.height || 46;
    var pad = { l: 9, r: 3, t: 5, b: 9 };
    if (!points.length) return '';

    var max = niceMax(Math.max.apply(null, points.map(function (p) { return p.value; })));
    var color = opts.color || '#3f7d8c';
    var n = points.length;
    var innerW = W - pad.l - pad.r, innerH = H - pad.t - pad.b;
    var slot = innerW / n, bw = Math.min(slot * 0.6, 9);

    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart" ' +
            'preserveAspectRatio="none" role="img">';

    [max, max / 2, 0].forEach(function (v) {
      var y = pad.t + innerH * (1 - (max ? v / max : 0));
      s += '<line x1="' + pad.l + '" y1="' + y + '" x2="' + (W - pad.r) +
           '" y2="' + y + '" class="grid"/>';
      s += '<text x="' + (pad.l - 1) + '" y="' + (y + 1.6) +
           '" class="ylab">' + Math.round(v) + '</text>';
    });

    points.forEach(function (p, i) {
      var h = max ? innerH * p.value / max : 0;
      var x = pad.l + slot * i + (slot - bw) / 2;
      s += '<rect x="' + x.toFixed(2) + '" y="' + (pad.t + innerH - h).toFixed(2) +
           '" width="' + bw.toFixed(2) + '" height="' + Math.max(h, 0.4).toFixed(2) +
           '" fill="' + color + '"><title>' + esc(p.tip || p.label) + '</title></rect>';
      s += '<text x="' + (x + bw / 2).toFixed(2) + '" y="' + (H - 1) +
           '" class="xlab">' + esc(p.label) + '</text>';
    });

    return s + '</svg>';
  }

  /** 圖表用的樣式，各頁面共用。 */
  var CSS =
    '.chart { width: 100%; height: 150px; display: block; }' +
    '.chart .grid { stroke: #e3ded4; stroke-width: 0.3; }' +
    '.chart .ylab { font-size: 3px; fill: #8a857d; text-anchor: end; }' +
    '.chart .xlab { font-size: 3px; fill: #8a857d; text-anchor: middle; }';

  root.FactChart = { line: line, bars: bars, CSS: CSS };
})(typeof self !== 'undefined' ? self : this);
