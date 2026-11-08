// FX MIC Patcher — local server.
// Opening v2.html directly works for everything except the microphone source:
// getUserMedia needs a secure context, and file:// is not one.
//
//   node serve.mjs              serve, open the browser when it is listening
//   node serve.mjs 8080         pick the starting port
//   node serve.mjs --no-open    do not launch a browser
import { createServer } from "node:http";
import { readFile, writeFile, copyFile, readdir, mkdir, open } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { extname, join, normalize } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const ROOT = import.meta.dirname;
const args = process.argv.slice(2);
const OPEN = !args.includes("--no-open");
const START_PORT = Number(args.find(a => /^\d+$/.test(a))) || 5173;
const PAGE = "v2.html";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
                ".css": "text/css", ".wav": "audio/wav", ".svg": "image/svg+xml" };

/* ====================== the fx-mic disk ======================
   USB on this device is a DISK, not a link: you copy config.json onto it and
   eject, and ejecting is what makes the device reload (since fw 1.0.5). Doing
   that by hand is download -> Save As -> find the file -> copy -> eject, five
   steps and a native dialog the page cannot reach. These three routes collapse
   it to one button.

   The browser cannot write to a volume, so the write has to happen here. The
   blast radius is kept narrow on purpose: we only ever touch a volume whose
   label looks like an fx-mic disk, the filename is hard-coded to config.json,
   and the body has to parse as JSON and look like a patch before it lands. */
let pushing = false;        /* no probing while a push/eject is in flight */
const DISK_LABEL = /^fx[-_ ]?mic/i;
const MAX_CONFIG = 64 * 1024;
const MAX_PUSH = 8 * 1024 * 1024;        /* config + every wav, base64-inflated */
/* Only ever write a plain wav filename at the root. No separators, no "..",
   nothing that could walk out of the volume we think we are writing to. */
const SAFE_WAV = /^[A-Za-z0-9 ._-]{1,64}\.wav$/i;
/* The fx-mic disk is ~1MB. Nothing else you would plug in is remotely that
   small, so size is the guard that lets us accept an unlabelled volume. */
const MAX_DISK = 64 * 1024 * 1024;

async function listRemovable() {
  if (process.platform === "win32") {
    // DriveType=2 is removable. PowerShell is the only way to read a volume
    // label on Windows — node has no API for it.
    const { stdout } = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' | " +
      "Select-Object DeviceID,VolumeName,FreeSpace,Size,FileSystem | ConvertTo-Json -Compress"], { timeout: 10000 });
    if (!stdout.trim()) return [];
    return [].concat(JSON.parse(stdout)).map(d => ({
      path: d.DeviceID + "\\", id: d.DeviceID, label: d.VolumeName || "", fs: d.FileSystem || "",
      free: Number(d.FreeSpace) || 0, size: Number(d.Size) || 0
    }));
  }
  const { readdir, statfs } = await import("node:fs/promises");
  const roots = process.platform === "darwin"
    ? ["/Volumes"] : ["/media/" + (process.env.USER || ""), "/run/media/" + (process.env.USER || "")];
  const out = [];
  for (const root of roots) {
    let names = [];
    try { names = await readdir(root); } catch { continue; }
    for (const n of names) {
      const path = join(root, n);
      let free = 0, size = 0;
      try { const st = await statfs(path); free = st.bsize * st.bavail; size = st.bsize * st.blocks; } catch {}
      out.push({ path, id: path, label: n, fs: "", free, size });
    }
  }
  return out;
}

/* Identifying the disk by LABEL ALONE was wrong. The same volume came up as
   "FX MIC DISK" once and with an EMPTY label and an empty filesystem the next
   time it enumerated, which left the push button dead with the device plugged
   in. Neither the label nor the files can be relied on, so size carries the
   identification: the fx-mic disk is 1MB, and no actual storage device you
   would plug into this machine is anywhere near that small. A labelled volume
   still wins outright; otherwise we take a removable FAT volume of <=64MB.
   The remaining guards do the real work — fixed filename, the body has to
   parse as a patch, and whatever was there is backed up first. */
async function findDisk() {
  let all = [];
  try { all = await listRemovable(); } catch { return { disk: null, candidates: [] }; }
  const checked = [];
  for (const d of all) {
    const labelled = DISK_LABEL.test(d.label);
    const small = d.size > 0 && d.size <= MAX_DISK;
    const fat = /^fat/i.test(d.fs);
    /* DO NOT open a file on the volume unless the cheap signals are not enough.
       This probe used to run on EVERY poll — and the page polls every 4s — so
       there was almost always an open handle on the disk, which is exactly what
       makes Windows refuse to eject it. We were fighting our own eject, and the
       device never reloaded. Label, size and filesystem all come from CIM and
       touch nothing. */
    let hasConfig = null;
    if (!labelled && small && !fat) {
      try { await readFile(join(d.path, "config.json")); hasConfig = true; } catch { hasConfig = false; }
    }
    checked.push({ ...d, labelled, hasConfig, small, fat });
  }
  const disk = checked.find(d => d.labelled)
    || checked.find(d => d.small && (d.fat || d.hasConfig))
    || null;
  return { disk, candidates: checked };
}

/* The eject IS the apply — the device re-reads samples and settings when the
   volume goes away, so reporting a success that did not happen is the single
   most misleading thing this server can do.

   `InvokeVerb('Eject')` returns NOTHING and does not throw when the verb
   silently fails, so "PowerShell exited 0" proves nothing at all. The only
   honest check is whether the volume actually disappeared. Flush first: writes
   to a FAT volume sit in the OS cache, and ejecting out from under them is how
   you get a config on the disk and a wav that never made it. */
async function ejectDisk(disk) {
  try {
    if (process.platform === "win32") {
      await run("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        `$v = New-Object -ComObject Shell.Application; ` +
        `$v.Namespace(17).ParseName('${disk.id}').InvokeVerb('Eject')`], { timeout: 15000 });
    } else if (process.platform === "darwin") {
      await run("diskutil", ["eject", disk.path], { timeout: 15000 });
    } else {
      await run("udisksctl", ["unmount", "-b", disk.path], { timeout: 15000 });
    }
  } catch { return false; }

  /* Believe it only when the MEDIA is gone — which is not the same as the
     drive letter going. On eject this device keeps K: and empties it: the
     logical disk still enumerates, with Size, FreeSpace and FileSystem all
     blank and K:\ not existing, exactly like a card reader with no card.
     Checking "did the letter disappear" therefore reported FAILED on every
     successful eject. It is also slow — well past the 4s I first allowed. */
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 500));
    let all = [];
    try { all = await listRemovable(); } catch { continue; }
    const still = all.find(d => d.id === disk.id);
    if (!still || !still.size) return true;
  }
  return false;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on("data", c => {
      n += c.length;
      if (n > limit) { reject(new Error("too large")); req.destroy(); return; }
      parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

const json = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  /* Any page in the browser can POST to localhost, so a write route needs a
     guard. Same-origin fetch from our own page sends no Origin header on a
     same-origin POST; a hostile cross-origin page always sends one. */
  if (url.pathname.startsWith("/device")) {
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      json(res, 403, { error: "cross-origin" }); return;
    }

    if (req.method === "GET" && pushing) {
      // a poll landing mid-eject can re-open the volume and block it
      json(res, 200, { ok: false, busy: true });
      return;
    }
    const { disk, candidates } = await findDisk();

    if (req.method === "GET") {
      // report what WAS seen when nothing matched, so a dead button can say why
      json(res, 200, disk
        ? { ok: true, disk: { name: disk.label || "(unlabelled)", id: disk.id, free: disk.free } }
        : { ok: false, seen: candidates.map(c => ({ id: c.id, label: c.label, fs: c.fs, hasConfig: c.hasConfig, small: c.small })) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/device") {
      if (!disk) { json(res, 404, { error: "no fx-mic disk found" }); return; }
      pushing = true;
      try {
      let raw;
      try { raw = await readBody(req, MAX_PUSH); }
      catch { json(res, 413, { error: "push too large" }); return; }

      /* The envelope carries the config AND the wavs, because the samples are
         useless without the config that names them and vice versa — a push
         that lands one but not the other leaves the device in a state neither
         of us chose. */
      let env;
      try { env = JSON.parse(raw); }
      catch (e) { json(res, 400, { error: "not valid JSON: " + e.message }); return; }

      const text = typeof env === "string" ? env : env.config;
      if (typeof text !== "string" || Buffer.byteLength(text) > MAX_CONFIG) {
        json(res, 400, { error: "no config in the push" }); return;
      }
      let parsed;
      try { parsed = JSON.parse(text); }
      catch (e) { json(res, 400, { error: "config is not valid JSON: " + e.message }); return; }
      if (!parsed || !Array.isArray(parsed.presets)) {
        json(res, 400, { error: "does not look like a config: no presets array" }); return;
      }

      // decode and vet every wav BEFORE anything is written, so a bad name in
      // slot 3 cannot leave slots 1 and 2 already on the disk
      const wavs = [];
      for (const w of Array.isArray(env.samples) ? env.samples : []) {
        if (!w || typeof w.file !== "string" || typeof w.b64 !== "string") continue;
        const name = w.file.trim();
        if (!SAFE_WAV.test(name)) {
          json(res, 400, { error: `"${name}" is not a plain .wav filename — rename the slot` }); return;
        }
        let bytes;
        try { bytes = Buffer.from(w.b64, "base64"); }
        catch { json(res, 400, { error: `could not decode ${name}` }); return; }
        if (bytes.length < 44 || bytes.subarray(0, 4).toString() !== "RIFF") {
          json(res, 400, { error: `${name} is not a wav file` }); return;
        }
        wavs.push({ name, bytes });
      }

      /* The budget is the disk, not a number I remember: ~1MB total across all
         four slots, and the device simply will not play a sample that did not
         fit. Checking here means the refusal names the problem instead of the
         device silently dropping a slot. */
      const incoming = Buffer.byteLength(text) + wavs.reduce((a, w) => a + w.bytes.length, 0);
      let keep = 0;
      try {
        for (const f of await readdir(disk.path)) {
          if (f === "config.json" || wavs.some(w => w.name.toLowerCase() === f.toLowerCase())) continue;
          if (!/\.wav$/i.test(f)) continue;
          const st = await readFile(join(disk.path, f));
          keep += st.length;
        }
      } catch {}
      if (disk.size && incoming + keep > disk.size) {
        json(res, 507, {
          error: `will not fit: ${Math.round((incoming + keep) / 1024)}KB to write` +
                 (keep ? ` (including ${Math.round(keep / 1024)}KB of wavs already on the disk)` : "") +
                 ` but ${disk.id} holds ${Math.round(disk.size / 1024)}KB. Drop a slot, or lower its quality.`
        }); return;
      }

      // back the whole volume up first — it is 1MB, and it may hold the only
      // copy of a sample or a patch that never existed anywhere else
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      let backup = null;
      try {
        const dir = join(ROOT, `device-backup-${stamp}`);
        for (const f of await readdir(disk.path)) {
          if (f === "System Volume Information") continue;
          try {
            const b = await readFile(join(disk.path, f));
            if (!backup) { await mkdir(dir, { recursive: true }); backup = dir; }
            await writeFile(join(dir, f), b);
          } catch {}
        }
      } catch { backup = null; }

      /* Write through a handle and fsync each one. Ejecting a FAT volume with
         writes still in the OS cache is how you end up with the small file on
         the disk and the big one missing. */
      const put = async (name, data) => {
        const fh = await open(join(disk.path, name), "w");
        try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
      };
      const wrote = [];
      try {
        await put("config.json", text); wrote.push("config.json");
        for (const w of wavs) { await put(w.name, w.bytes); wrote.push(w.name); }
      } catch (e) {
        json(res, 500, { error: `could not write to ${disk.id}: ${e.message}`, wrote }); return;
      }

      // eject is not politeness, it is the reload: the device re-reads samples
      // and settings on eject (fw 1.0.5+), so a push that does not eject does
      // nothing at all
      const ejected = url.searchParams.get("eject") !== "0" ? await ejectDisk(disk) : null;
      json(res, 200, {
        ok: true, disk: disk.label || disk.id, bytes: incoming,
        wrote, backup, ejected
      });
      return;
      } finally { pushing = false; }
    }

    json(res, 405, { error: "method not allowed" });
    return;
  }

  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  const file = join(ROOT, rel || PAGE);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

// if 5173 is already taken — often by a copy left running — walk up instead of dying
let port = START_PORT;
server.on("error", err => {
  if (err.code === "EADDRINUSE" && port < START_PORT + 10) { server.listen(++port, HOST); return; }
  console.error(err.message);
  process.exit(1);
});

/* LOOPBACK ONLY. listen(port) with no host binds 0.0.0.0 — every interface —
   and /device WRITES TO A REMOVABLE DISK and ejects it. The Origin guard does
   not cover this: it only rejects a request that carries a wrong Origin, and a
   direct curl from another machine carries none at all. On any shared network
   that is a stranger writing to your device. There is no reason this server
   should ever be reachable from off the machine. */
const HOST = "127.0.0.1";

server.listen(port, HOST, () => {
  const url = `http://localhost:${port}/${PAGE}`;
  console.log(`\n  FX MIC PATCHER   ${url}`);
  console.log("  close this window to stop the server\n");
  // opened here rather than from the .bat, so there is no delay to guess at
  if (OPEN) {
    const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    try { spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).unref(); } catch {}
  }
});
