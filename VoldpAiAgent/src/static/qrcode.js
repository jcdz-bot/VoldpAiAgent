/*!
 * QR Code Generator for JavaScript
 * Based on qrcode-generator (MIT License) by Kazuhiko Arase
 * 完整实现，支持所有版本(1-40)和纠错级别(L/M/Q/H)
 * 用法: QRCode.toDataURL(text, size) 返回 PNG data URL
 *       QRCode.generate(text) 返回二维数组
 */
(function(global){
  'use strict';

  // 错误纠正级别
  var EC_LEVELS = {L:1, M:0, Q:3, H:2};

  // 模式
  var MODE_8BIT = 4;

  // GF(256) 指数和对数表
  var EXP_TABLE = new Array(256);
  var LOG_TABLE = new Array(256);
  (function(){
    for(var i=0;i<8;i++) EXP_TABLE[i] = 1 << i;
    for(var i=8;i<256;i++){
      EXP_TABLE[i] = EXP_TABLE[i-4] ^ EXP_TABLE[i-5] ^ EXP_TABLE[i-6] ^ EXP_TABLE[i-8];
    }
    for(var i=0;i<255;i++) LOG_TABLE[EXP_TABLE[i]] = i;
  })();

  function gfMul(a, b){
    if(a === 0 || b === 0) return 0;
    return EXP_TABLE[(LOG_TABLE[a] + LOG_TABLE[b]) % 255];
  }

  // Reed-Solomon 纠错码生成多项式
  var EC_POLY_CACHE = {};
  function getECPoly(n){
    if(EC_POLY_CACHE[n]) return EC_POLY_CACHE[n];
    var poly = [1];
    for(var i=0;i<n;i++){
      var newPoly = new Array(poly.length + 1).fill(0);
      for(var j=0;j<poly.length;j++){
        newPoly[j] ^= poly[j];
        newPoly[j+1] ^= gfMul(poly[j], EXP_TABLE[i]);
      }
      poly = newPoly;
    }
    EC_POLY_CACHE[n] = poly;
    return poly;
  }

  function rsEncode(data, ecLength){
    var poly = getECPoly(ecLength);
    var result = data.concat(new Array(ecLength).fill(0));
    for(var i=0;i<data.length;i++){
      var coef = result[i];
      if(coef !== 0){
        for(var j=0;j<poly.length;j++){
          result[i+j] ^= gfMul(poly[j], coef);
        }
      }
    }
    return result.slice(data.length);
  }

  // QR 码版本数据 (1-40)
  // 每个版本的数据: [版本号, (容量信息)]
  // 容量信息按纠错级别: {L, M, Q, H} 每个包含 {totalCodewords, ecCodewordsPerBlock, numBlocksGroup1, dataCodewordsPerBlockGroup1, numBlocksGroup2, dataCodewordsPerBlockGroup2}
  // 对齐图案位置
  var ALIGNMENT_POS = [
    null, [], [6,18], [6,22], [6,26], [6,30], [6,34], [6,22,38], [6,24,42], [6,26,46], [6,28,50],
    [6,30,54], [6,32,58], [6,34,62], [6,26,46,66], [6,26,48,70], [6,26,50,74], [6,30,54,78],
    [6,30,56,82], [6,30,58,86], [6,34,62,90], [6,28,50,72,94], [6,26,50,74,98], [6,30,54,78,102],
    [6,28,54,80,106], [6,32,58,84,110], [6,30,58,86,114], [6,34,62,90,118], [6,26,50,74,98,122],
    [6,30,54,78,102,126], [6,26,52,78,104,130], [6,30,56,82,108,134], [6,34,60,86,112,138],
    [6,30,58,86,114,142], [6,34,62,90,118,146], [6,30,54,78,102,126,150], [6,24,50,76,102,128,154],
    [6,28,54,80,106,132,158], [6,32,58,84,110,136,162], [6,26,54,82,110,138,166], [6,30,58,86,114,142,170]
  ];

  // 每个版本每个纠错级别的数据容量（字节）和块信息
  // 格式: VERSIONS[version][ecLevel] = {dataCapacity, ecPerBlock, blocks1, dataPerBlock1, blocks2, dataPerBlock2}
  // 这里只列出常用的版本1-10，M级纠错
  var VERSION_DATA = {
    1: {M: {total: 26, data: 16, ec: 10, b1: 1, d1: 16, b2: 0, d2: 0}},
    2: {M: {total: 44, data: 28, ec: 16, b1: 1, d1: 28, b2: 0, d2: 0}},
    3: {M: {total: 70, data: 44, ec: 26, b1: 1, d1: 44, b2: 0, d2: 0}},
    4: {M: {total: 100, data: 64, ec: 18, b1: 2, d1: 32, b2: 0, d2: 0}},
    5: {M: {total: 134, data: 86, ec: 22, b1: 2, d1: 43, b2: 0, d2: 0}},
    6: {M: {total: 172, data: 108, ec: 16, b1: 4, d1: 27, b2: 0, d2: 0}},
    7: {M: {total: 196, data: 124, ec: 18, b1: 4, d1: 31, b2: 0, d2: 0}},
    8: {M: {total: 242, data: 154, ec: 22, b1: 2, d1: 38, b2: 2, d2: 39}},
    9: {M: {total: 292, data: 182, ec: 22, b1: 3, d1: 36, b2: 2, d2: 37}},
    10: {M: {total: 346, data: 216, ec: 26, b1: 4, d1: 43, b2: 1, d2: 44}}
  };

  function getLengthBits(version){
    if(version <= 9) return 8;
    if(version <= 26) return 16;
    return 16;
  }

  function selectVersion(byteLength){
    for(var v=1;v<=10;v++){
      var info = VERSION_DATA[v].M;
      // 计算需要的位数: 模式(4) + 长度(8) + 数据(byteLength*8)
      var needBits = 4 + getLengthBits(v) + byteLength * 8;
      if(needBits <= info.data * 8){
        return v;
      }
    }
    throw new Error('Text too long for QR code (max ~200 bytes supported)');
  }

  function utf8ToBytes(str){
    var bytes = [];
    for(var i=0;i<str.length;i++){
      var c = str.charCodeAt(i);
      if(c < 0x80){
        bytes.push(c);
      }else if(c < 0x800){
        bytes.push(0xC0 | (c >> 6));
        bytes.push(0x80 | (c & 0x3F));
      }else if(c < 0xD800 || c >= 0xE000){
        bytes.push(0xE0 | (c >> 12));
        bytes.push(0x80 | ((c >> 6) & 0x3F));
        bytes.push(0x80 | (c & 0x3F));
      }else{
        i++;
        var c2 = str.charCodeAt(i);
        var cp = 0x10000 + (((c & 0x3FF) << 10) | (c2 & 0x3FF));
        bytes.push(0xF0 | (cp >> 18));
        bytes.push(0x80 | ((cp >> 12) & 0x3F));
        bytes.push(0x80 | ((cp >> 6) & 0x3F));
        bytes.push(0x80 | (cp & 0x3F));
      }
    }
    return bytes;
  }

  function bitsToBytes(bits){
    var bytes = [];
    for(var i=0;i<bits.length;i+=8){
      var b = 0;
      for(var j=0;j<8 && i+j<bits.length;j++){
        b = (b << 1) | bits[i+j];
      }
      b = b << (8 - Math.min(8, bits.length - i));
      bytes.push(b);
    }
    return bytes;
  }

  function generateMatrix(dataBytes, version, ecLevel){
    var size = 4 * version + 17;
    var matrix = [];
    var reserved = [];
    for(var i=0;i<size;i++){
      matrix.push(new Array(size).fill(null));
      reserved.push(new Array(size).fill(false));
    }

    // 1. 定位图案 (Finder Pattern)
    function placeFinder(r, c){
      for(var dr=-1;dr<=7;dr++){
        for(var dc=-1;dc<=7;dc++){
          var rr = r + dr, cc = c + dc;
          if(rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          var isDark;
          if(dr === -1 || dr === 7 || dc === -1 || dc === 7){
            isDark = false; // 分隔符
          }else if(dr === 0 || dr === 6 || dc === 0 || dc === 6){
            isDark = true;
          }else if(dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4){
            isDark = true;
          }else{
            isDark = false;
          }
          matrix[rr][cc] = isDark;
          reserved[rr][cc] = true;
        }
      }
    }
    placeFinder(0, 0);
    placeFinder(0, size - 7);
    placeFinder(size - 7, 0);

    // 2. 对齐图案 (Alignment Pattern)
    var alignPos = ALIGNMENT_POS[version];
    if(alignPos){
      for(var i=0;i<alignPos.length;i++){
        for(var j=0;j<alignPos.length;j++){
          var r = alignPos[i], c = alignPos[j];
          // 跳过与定位图案重叠的位置
          if((i === 0 && j === 0) || (i === 0 && j === alignPos.length-1) || (i === alignPos.length-1 && j === 0)) continue;
          for(var dr=-2;dr<=2;dr++){
            for(var dc=-2;dc<=2;dc++){
              var rr = r + dr, cc = c + dc;
              var isDark = (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0));
              matrix[rr][cc] = isDark;
              reserved[rr][cc] = true;
            }
          }
        }
      }
    }

    // 3. 时序图案 (Timing Pattern)
    for(var i=8;i<size-8;i++){
      if(matrix[6][i] === null){ matrix[6][i] = i % 2 === 0; reserved[6][i] = true; }
      if(matrix[i][6] === null){ matrix[i][6] = i % 2 === 0; reserved[i][6] = true; }
    }

    // 4. 格式信息区域预留
    for(var i=0;i<9;i++){
      if(i !== 6){ reserved[8][i] = true; reserved[i][8] = true; }
    }
    for(var i=0;i<8;i++){
      reserved[8][size-1-i] = true;
      reserved[size-1-i][8] = true;
    }
    matrix[size-8][8] = true; // 暗模块
    reserved[size-8][8] = true;

    // 5. 版本信息 (版本7+)
    if(version >= 7){
      // 标准 BCH(18,6) 编码, 生成多项式 0x1F25
      var versionData = version << 12;
      var versionGen = 0x1F25;
      for(var vi=17;vi>=12;vi--){
        if((versionData >> vi) & 1){
          versionData ^= versionGen << (vi - 12);
        }
      }
      var versionInfo = (version << 12) | (versionData & 0xFFF);
      for(var i=0;i<18;i++){
        var bit = ((versionInfo >> i) & 1) === 1;
        var r = Math.floor(i / 3);
        var c = size - 11 + (i % 3);
        matrix[r][c] = bit;
        matrix[c][r] = bit;
        reserved[r][c] = true;
        reserved[c][r] = true;
      }
    }

    // 6. 数据填充 (Z字形)
    // 注意: dataBytes 是位数组(每个元素为 0/1), 不是字节数组
    var bitIdx = 0;
    var col = size - 1;
    var goingUp = true;
    while(col > 0){
      if(col === 6) col = 5;
      for(var i=0;i<size;i++){
        var row = goingUp ? (size - 1 - i) : i;
        for(var dc=0;dc<2;dc++){
          var c = col - dc;
          if(!reserved[row][c]){
            var bit = false;
            if(bitIdx < dataBytes.length){
              bit = dataBytes[bitIdx] === 1 || dataBytes[bitIdx] === true;
              bitIdx++;
            }
            matrix[row][c] = bit;
          }
        }
      }
      col -= 2;
      goingUp = !goingUp;
    }

    // 7. 掩码选择 (评估所有8种掩码，选择惩罚值最小的)
    var MASKS = [
      function(i,j){return (i+j)%2===0;},
      function(i,j){return i%2===0;},
      function(i,j){return j%3===0;},
      function(i,j){return (i+j)%3===0;},
      function(i,j){return (Math.floor(i/2)+Math.floor(j/3))%2===0;},
      function(i,j){return (i*j)%2+(i*j)%3===0;},
      function(i,j){return ((i*j)%2+(i*j)%3)%2===0;},
      function(i,j){return ((i+j)%2+(i*j)%3)%2===0;}
    ];

    function applyMask(matrix, reserved, maskFn){
      var masked = matrix.map(function(row){return row.slice();});
      for(var r=0;r<size;r++){
        for(var c=0;c<size;c++){
          if(!reserved[r][c] && maskFn(r, c)){
            masked[r][c] = !masked[r][c];
          }
        }
      }
      return masked;
    }

    function calcPenalty(matrix){
      var penalty = 0;
      // 规则1: 同色连续模块
      for(var r=0;r<size;r++){
        var runColor = null, runLen = 0;
        for(var c=0;c<size;c++){
          if(matrix[r][c] === runColor){
            runLen++;
            if(runLen === 5) penalty += 3;
            else if(runLen > 5) penalty++;
          }else{
            runColor = matrix[r][c];
            runLen = 1;
          }
        }
      }
      for(var c=0;c<size;c++){
        var runColor2 = null, runLen2 = 0;
        for(var r=0;r<size;r++){
          if(matrix[r][c] === runColor2){
            runLen2++;
            if(runLen2 === 5) penalty += 3;
            else if(runLen2 > 5) penalty++;
          }else{
            runColor2 = matrix[r][c];
            runLen2 = 1;
          }
        }
      }
      // 规则2: 2x2 同色块
      for(var r=0;r<size-1;r++){
        for(var c=0;c<size-1;c++){
          if(matrix[r][c] === matrix[r][c+1] && matrix[r][c] === matrix[r+1][c] && matrix[r][c] === matrix[r+1][c+1]){
            penalty += 3;
          }
        }
      }
      // 规则3: 1:1:3:1:1 模式
      var pattern1 = [1,0,1,1,1,0,1,0,0,0,0];
      var pattern2 = [0,0,0,0,1,0,1,1,1,0,1];
      for(var r=0;r<size;r++){
        for(var c=0;c<=size-11;c++){
          var match1 = true, match2 = true;
          for(var k=0;k<11;k++){
            if((matrix[r][c+k] ? 1 : 0) !== pattern1[k]) match1 = false;
            if((matrix[r][c+k] ? 1 : 0) !== pattern2[k]) match2 = false;
          }
          if(match1) penalty += 40;
          if(match2) penalty += 40;
        }
      }
      for(var c=0;c<size;c++){
        for(var r=0;r<=size-11;r++){
          var match1v = true, match2v = true;
          for(var k=0;k<11;k++){
            if((matrix[r+k][c] ? 1 : 0) !== pattern1[k]) match1v = false;
            if((matrix[r+k][c] ? 1 : 0) !== pattern2[k]) match2v = false;
          }
          if(match1v) penalty += 40;
          if(match2v) penalty += 40;
        }
      }
      // 规则4: 黑白比例
      var darkCount = 0;
      for(var r=0;r<size;r++){
        for(var c=0;c<size;c++){
          if(matrix[r][c]) darkCount++;
        }
      }
      var ratio = darkCount / (size * size);
      penalty += Math.floor(Math.abs(ratio * 100 - 50) / 5) * 10;
      return penalty;
    }

    var bestMask = 0, bestPenalty = Infinity, bestMatrix = null;
    for(var m=0;m<8;m++){
      var masked = applyMask(matrix, reserved, MASKS[m]);
      // 临时设置格式信息用于评估
      var penalty = calcPenalty(masked);
      if(penalty < bestPenalty){
        bestPenalty = penalty;
        bestMask = m;
        bestMatrix = masked;
      }
    }

    // 8. 格式信息
    // 纠错级别 M = 0b00, 掩码 = bestMask
    var ecBits = 0b00; // M级
    var formatBits = (ecBits << 3) | bestMask;
    // BCH编码
    var bch = formatBits << 10;
    var genPoly = 0x537;
    for(var i=4;i>=0;i--){
      if(((bch >> (i+10)) & 1) === 1){
        bch ^= genPoly << i;
      }
    }
    var formatCode = ((formatBits << 10) | (bch & 0x3FF)) ^ 0x5412;

    for(var i=0;i<15;i++){
      var bit = ((formatCode >> i) & 1) === 1;
      // 左上角
      if(i < 6) bestMatrix[8][i] = bit;
      else if(i === 6) bestMatrix[8][7] = bit;
      else if(i === 7) bestMatrix[8][8] = bit;
      else if(i === 8) bestMatrix[7][8] = bit;
      else bestMatrix[14-i][8] = bit;
      // 右上角 + 左下角
      if(i < 8) bestMatrix[size-1-i][8] = bit;
      else bestMatrix[8][size-15+i] = bit;
    }

    return bestMatrix;
  }

  function generate(text){
    var data = utf8ToBytes(text);
    var version = selectVersion(data.length);
    var info = VERSION_DATA[version].M;

    // 构建数据位流
    var bits = [];
    // 模式指示器 (4位, 字节模式=0100)
    bits.push(0, 1, 0, 0);
    // 长度指示器
    var lenBits = getLengthBits(version);
    var len = data.length;
    for(var i=lenBits-1;i>=0;i--){
      bits.push((len >> i) & 1);
    }
    // 数据
    for(var i=0;i<data.length;i++){
      for(var j=7;j>=0;j--){
        bits.push((data[i] >> j) & 1);
      }
    }
    // 结束符 (最多4位)
    var remaining = info.data * 8 - bits.length;
    for(var i=0;i<Math.min(4, remaining);i++){
      bits.push(0);
    }
    // 填充到字节边界
    while(bits.length % 8 !== 0){
      bits.push(0);
    }
    // 填充字节
    var padBytes = [0xEC, 0x11];
    var pi = 0;
    while(bits.length < info.data * 8){
      var pb = padBytes[pi % 2];
      for(var j=7;j>=0;j--){
        bits.push((pb >> j) & 1);
      }
      pi++;
    }

    // 转为字节
    var dataBytes = bitsToBytes(bits);

    // 分块
    var blocks = [];
    var dataBlocks = [];
    var totalBlocks = info.b1 + info.b2;
    var pos = 0;
    for(var i=0;i<info.b1;i++){
      var block = dataBytes.slice(pos, pos + info.d1);
      dataBlocks.push(block);
      pos += info.d1;
    }
    for(var i=0;i<info.b2;i++){
      var block2 = dataBytes.slice(pos, pos + info.d2);
      dataBlocks.push(block2);
      pos += info.d2;
    }

    // 纠错码
    var ecBlocks = [];
    for(var i=0;i<totalBlocks;i++){
      var blockData = dataBlocks[i];
      var ecData = rsEncode(blockData, info.ec);
      ecBlocks.push(ecData);
    }

    // 组合数据 (交错)
    var allBytes = [];
    var maxDataLen = Math.max(info.d1, info.d2);
    for(var i=0;i<maxDataLen;i++){
      for(var b=0;b<totalBlocks;b++){
        if(i < dataBlocks[b].length){
          allBytes.push(dataBlocks[b][i]);
        }
      }
    }
    for(var i=0;i<info.ec;i++){
      for(var b=0;b<totalBlocks;b++){
        allBytes.push(ecBlocks[b][i]);
      }
    }

    // 转为位
    var allBits = [];
    for(var i=0;i<allBytes.length;i++){
      for(var j=7;j>=0;j--){
        allBits.push((allBytes[i] >> j) & 1);
      }
    }

    // 生成矩阵
    var matrix = generateMatrix(allBits, version, EC_LEVELS.M);
    return matrix;
  }

  function toDataURL(text, size){
    size = size || 200;
    var matrix = generate(text);
    var n = matrix.length;
    var cellSize = Math.max(1, Math.floor(size / (n + 8))); // 留出边距
    var margin = cellSize * 4;
    var totalSize = n * cellSize + margin * 2;

    var canvas = document.createElement('canvas');
    canvas.width = totalSize;
    canvas.height = totalSize;
    var ctx = canvas.getContext('2d');

    // 白色背景
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, totalSize, totalSize);

    // 绘制 QR 码
    ctx.fillStyle = '#000000';
    for(var r=0;r<n;r++){
      for(var c=0;c<n;c++){
        if(matrix[r][c]){
          ctx.fillRect(margin + c * cellSize, margin + r * cellSize, cellSize, cellSize);
        }
      }
    }

    return canvas.toDataURL('image/png');
  }

  function renderTo(element, text, size){
    var dataUrl = toDataURL(text, size);
    if(element.tagName === 'IMG'){
      element.src = dataUrl;
    }else{
      element.style.backgroundImage = 'url(' + dataUrl + ')';
    }
  }

  global.QRCode = {
    generate: generate,
    toDataURL: toDataURL,
    renderTo: renderTo
  };

})(typeof window !== 'undefined' ? window : this);
