export const HOTSPOT_ASSETS: Record<string, { contentType: string; body: string }> = {
  'login.html': {
    contentType: 'text/html; charset=utf-8',
    body: String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hotspot Login</title>
    <link rel="stylesheet" href="style.css" />
    <script src="md5.js"></script>
    <script>
      function submitLogin() {
        var form = document.forms.login;
        var challenge = "$(chap-challenge)";
        var id = "$(chap-id)";
        if (!challenge || !id) return false;
        document.forms.sendin.username.value = form.username.value;
        document.forms.sendin.password.value = hexMD5(id + form.password.value + challenge);
        document.forms.sendin.submit();
        return false;
      }
    </script>
  </head>
  <body>
    <main class="shell">
      <section class="panel hero">
        <p class="eyebrow">ISPFlow Hotspot</p>
        <h1>Connect to the internet</h1>
        <p class="lead">Sign in with the username and password provided by your internet provider.</p>
        <form name="sendin" action="$(link-login-only)" method="post">
          <input type="hidden" name="username" />
          <input type="hidden" name="password" />
          <input type="hidden" name="dst" value="$(link-orig)" />
          <input type="hidden" name="popup" value="true" />
        </form>
        <form name="login" class="form" action="$(link-login-only)" method="post" onsubmit="return submitLogin()">
          <input type="hidden" name="dst" value="$(link-orig)" />
          <input type="hidden" name="popup" value="true" />
          <label>Username or voucher code
            <input name="username" type="text" placeholder="Enter your username" autocomplete="username" required />
          </label>
          <label>Password
            <input name="password" type="password" placeholder="Enter your password" autocomplete="current-password" required />
          </label>
          <button type="submit">Connect</button>
        </form>
        <div class="note"><span>Need access? Contact your internet provider.</span></div>
      </section>
    </main>
  </body>
</html>`,
  },
  'alogin.html': {
    contentType: 'text/html; charset=utf-8',
    body: String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="2; url=$(link-status)" />
    <title>Hotspot Connected</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body><main class="shell"><section class="panel">
    <p class="eyebrow">ISPFlow Hotspot</p><h1>You are connected</h1>
    <p class="lead">Your internet session is ready. You will be redirected shortly.</p>
    <a class="button" href="$(link-orig)">Continue</a>
  </section></main></body>
</html>`,
  },
  'error.html': {
    contentType: 'text/html; charset=utf-8',
    body: String.raw`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hotspot Sign-in Error</title><link rel="stylesheet" href="style.css" /></head>
  <body><main class="shell"><section class="panel">
    <p class="eyebrow">Sign-in failed</p><h1>Unable to connect</h1>
    <p class="lead">$(error)</p><a class="button" href="$(link-login-only)">Try again</a>
  </section></main></body>
</html>`,
  },
  'logout.html': {
    contentType: 'text/html; charset=utf-8',
    body: String.raw`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hotspot Logout</title><link rel="stylesheet" href="style.css" />
    <meta http-equiv="refresh" content="3; url=$(link-login-only)" /></head>
  <body><main class="shell"><section class="panel">
    <p class="eyebrow">Session closed</p><h1>You have been disconnected</h1>
    <p class="lead">Sign in again whenever you are ready to reconnect.</p>
    <a class="button" href="$(link-login-only)">Go back to login</a>
  </section></main></body>
</html>`,
  },
  'status.html': {
    contentType: 'text/html; charset=utf-8',
    body: String.raw`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hotspot Session Status</title><link rel="stylesheet" href="style.css" />
    <meta http-equiv="refresh" content="30" /></head>
  <body><main class="shell"><section class="panel">
    <p class="eyebrow">Session Active</p><h1>You're connected</h1>
    <div class="stack">
      <div class="row"><span>User</span><strong>$(username)</strong></div>
      <div class="row"><span>IP Address</span><strong>$(ip)</strong></div>
      <div class="row"><span>Uptime</span><strong>$(uptime)</strong></div>
      <div class="row"><span>Data Used</span><strong>$(bytes-in-nice) down / $(bytes-out-nice) up</strong></div>
    </div>
    <a class="button secondary" href="$(link-logout)">Logout</a>
  </section></main></body>
</html>`,
  },
  'style.css': {
    contentType: 'text/css; charset=utf-8',
    body: String.raw`:root {
  color-scheme: dark;
  --bg: #020617;
  --panel: rgba(15, 23, 42, 0.82);
  --border: rgba(148, 163, 184, 0.18);
  --text: #e2e8f0;
  --muted: #94a3b8;
  --button: #7c3aed;
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; font-family: Inter, system-ui, sans-serif; background: radial-gradient(circle at top, rgba(139,92,246,0.25), transparent 35%), radial-gradient(circle at bottom right, rgba(6,182,212,0.18), transparent 30%), var(--bg); color: var(--text); }
a { color: inherit; text-decoration: none; }
.shell { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
.panel { width: min(680px, 100%); padding: 28px; border: 1px solid var(--border); border-radius: 28px; background: var(--panel); box-shadow: 0 30px 80px rgba(2, 6, 23, 0.4); }
.hero h1, .panel h1 { margin: 0; font-size: clamp(2rem, 5vw, 3.5rem); line-height: 1.05; }
.eyebrow { margin: 0 0 10px; text-transform: uppercase; letter-spacing: .22em; font-size: 11px; color: #c4b5fd; }
.lead { color: var(--muted); line-height: 1.7; margin: 14px 0 0; font-size: 15px; }
.form { margin-top: 22px; display: grid; gap: 14px; }
.form label { display: grid; gap: 8px; font-size: 12px; color: #cbd5e1; }
.form input { width: 100%; border-radius: 16px; border: 1px solid rgba(148,163,184,.22); background: rgba(15,23,42,.85); color: white; padding: 14px 16px; font-size: 15px; }
.form button, .button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; border: 0; border-radius: 16px; padding: 14px 18px; background: linear-gradient(90deg, var(--button), #2563eb); color: white; font-weight: 700; cursor: pointer; }
.button.secondary { background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.12); }
.note, .stack { margin-top: 18px; display: grid; gap: 10px; color: var(--muted); font-size: 12px; }
.row { display: flex; justify-content: space-between; gap: 12px; padding: 12px 14px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.06); border-radius: 14px; }
.row strong { color: #fff; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }`,
  },
  'md5.js': {
    contentType: 'application/javascript; charset=utf-8',
    body: String.raw`function hexMD5(value) {
  var bytes = unescape(encodeURIComponent(value));
  var length = bytes.length;
  var paddedLength = Math.ceil((length + 9) / 64) * 64;
  var message = new Uint8Array(paddedLength);
  var state = [1732584193, -271733879, -1732584194, 271733878];
  var shifts = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  var constants = [];
  var i;
  for (i = 0; i < length; i++) message[i] = bytes.charCodeAt(i);
  message[length] = 128;
  var bitLength = length * 8;
  for (i = 0; i < 4; i++) message[paddedLength - 8 + i] = (bitLength >>> (i * 8)) & 255;
  for (i = 0; i < 64; i++) constants[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  function add32(a, b) { return (a + b) | 0; }
  function rotateLeft(value, count) { return (value << count) | (value >>> (32 - count)); }
  for (var offset = 0; offset < paddedLength; offset += 64) {
    var words = [];
    for (i = 0; i < 16; i++) { var pos = offset + i * 4; words[i] = message[pos] | (message[pos + 1] << 8) | (message[pos + 2] << 16) | (message[pos + 3] << 24); }
    var a = state[0], b = state[1], c = state[2], d = state[3];
    for (i = 0; i < 64; i++) {
      var f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      var previousD = d;
      d = c; c = b;
      b = add32(b, rotateLeft(add32(add32(a, f), add32(constants[i], words[g])), shifts[i]));
      a = previousD;
    }
    state[0] = add32(state[0], a); state[1] = add32(state[1], b);
    state[2] = add32(state[2], c); state[3] = add32(state[3], d);
  }
  var result = '';
  for (i = 0; i < state.length; i++) for (var byte = 0; byte < 4; byte++) {
    var value = (state[i] >>> (byte * 8)) & 255;
    result += (value < 16 ? '0' : '') + value.toString(16);
  }
  return result;
}`,
  },
}

export const HOTSPOT_ASSET_NAMES = Object.keys(HOTSPOT_ASSETS)
