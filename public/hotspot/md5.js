function hexMD5(value) {
  var bytes = unescape(encodeURIComponent(value));
  var length = bytes.length;
  var paddedLength = Math.ceil((length + 9) / 64) * 64;
  var message = new Uint8Array(paddedLength);
  var state = [1732584193, -271733879, -1732584194, 271733878];
  var shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];
  var constants = [];
  var i;

  for (i = 0; i < length; i++) message[i] = bytes.charCodeAt(i);
  message[length] = 128;
  var bitLength = length * 8;
  for (i = 0; i < 4; i++) {
    message[paddedLength - 8 + i] = (bitLength >>> (i * 8)) & 255;
  }
  for (i = 0; i < 64; i++) {
    constants[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  }

  function add32(a, b) {
    return (a + b) | 0;
  }

  function rotateLeft(value, count) {
    return (value << count) | (value >>> (32 - count));
  }

  for (var offset = 0; offset < paddedLength; offset += 64) {
    var words = [];
    for (i = 0; i < 16; i++) {
      var pos = offset + i * 4;
      words[i] = message[pos] | (message[pos + 1] << 8)
        | (message[pos + 2] << 16) | (message[pos + 3] << 24);
    }

    var a = state[0];
    var b = state[1];
    var c = state[2];
    var d = state[3];
    for (i = 0; i < 64; i++) {
      var f;
      var g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      var previousD = d;
      d = c;
      c = b;
      b = add32(b, rotateLeft(
        add32(add32(a, f), add32(constants[i], words[g])),
        shifts[i]
      ));
      a = previousD;
    }
    state[0] = add32(state[0], a);
    state[1] = add32(state[1], b);
    state[2] = add32(state[2], c);
    state[3] = add32(state[3], d);
  }

  var result = '';
  for (i = 0; i < state.length; i++) {
    for (var byte = 0; byte < 4; byte++) {
      var value = (state[i] >>> (byte * 8)) & 255;
      result += (value < 16 ? '0' : '') + value.toString(16);
    }
  }
  return result;
}
