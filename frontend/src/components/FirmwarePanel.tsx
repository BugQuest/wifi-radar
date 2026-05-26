import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useDraggable } from "../lib/useDraggable";

const PRO = window.location.protocol === "https:" ? "https:" : "http:";
const API = `${PRO}//${window.location.host}/api`;

interface UploadInfo {
  file_id: string;
  filename: string;
  size: number;
}

interface FwStatus {
  esptool_available: boolean;
  esptool_bin: string;
  app_offset: string;
  flash_baud: string;
}

const LOG_LIMIT = 1000;

export function FirmwarePanel() {
  const visible = useStore((s) => s.panels.firmware);
  const togglePanel = useStore((s) => s.togglePanel);
  const sensors = useStore((s) => s.sensors);
  const drag = useDraggable();

  const [status, setStatus] = useState<FwStatus | null>(null);
  const [upload, setUpload] = useState<UploadInfo | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [targetSid, setTargetSid] = useState("");
  const [flashing, setFlashing] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [done, setDone] = useState<"ok" | "err" | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Poll backend status so we can warn about missing esptool right away.
  useEffect(() => {
    let alive = true;
    fetch(`${API}/firmware/status`)
      .then((r) => r.json())
      .then((s) => { if (alive) setStatus(s); })
      .catch(() => { /* leave null, UI will say "unknown" */ });
    return () => { alive = false; };
  }, []);

  // Default target sid to the first reporting sensor.
  useEffect(() => {
    if (!targetSid) {
      const first = [...sensors.values()].find((s) => s.connected)?.id;
      if (first) setTargetSid(first);
    }
  }, [sensors, targetSid]);

  // Keep the log view scrolled to the bottom while it grows.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true);
    setUpload(null);
    setUploadErr(null);
    setDone(null);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await fetch(`${API}/firmware/upload`, { method: "POST", body: fd });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.detail ?? `${r.status}`);
      setUpload({ file_id: data.file_id, filename: data.filename, size: data.size });
    } catch (err) {
      setUploadErr(String(err));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const appendLine = (line: string) => {
    setLog((prev) => {
      const next = [...prev, line];
      if (next.length > LOG_LIMIT) next.splice(0, next.length - LOG_LIMIT);
      return next;
    });
  };

  const flash = async () => {
    if (!upload || !targetSid || flashing) return;
    setFlashing(true);
    setLog([]);
    setDone(null);
    try {
      const r = await fetch(`${API}/firmware/flash`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: upload.file_id, sid: targetSid }),
      });
      if (!r.ok || !r.body) {
        const txt = await r.text();
        appendLine(`HTTP ${r.status}: ${txt}`);
        setDone("err");
        return;
      }
      // Stream the response body line by line.
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let result: "ok" | "err" | null = null;
      while (true) {
        const { value, done: rdone } = await reader.read();
        if (rdone) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          appendLine(line);
          if (line.startsWith("FLASH_OK")) result = "ok";
          else if (line.startsWith("FLASH_ERROR")) result = "err";
        }
      }
      if (pending) appendLine(pending);
      setDone(result ?? "err");
      // After a successful flash, the upload is consumed server-side.
      if (result === "ok") setUpload(null);
    } catch (e) {
      appendLine(`FLASH_ERROR: ${String(e)}`);
      setDone("err");
    } finally {
      setFlashing(false);
    }
  };

  if (!visible) return null;

  const sensorList = [...sensors.values()].sort((a, b) => a.id.localeCompare(b.id));
  const hasEsptool = status?.esptool_available ?? false;

  return (
    <div
      className="
        absolute right-2 top-2 left-2 max-h-[calc(100vh-1rem)]
        sm:right-3 sm:top-16 sm:left-auto sm:w-[28rem] sm:max-h-[calc(100vh-5rem)]
        flex flex-col bg-radar-panel/95 border border-radar-border rounded font-mono text-[10px] z-20
      "
      style={drag.style}
    >
      <div
        {...drag.headerProps}
        className="flex items-center gap-2 px-3 py-2 border-b border-radar-border hover:bg-radar-bg/60 select-none shrink-0"
      >
        <span className="text-zinc-300 uppercase tracking-wider">🔥 Firmware updater</span>
        <span className="ml-auto text-zinc-500">{sensorList.length} sensor(s)</span>
        <button
          onClick={() => togglePanel("firmware")}
          className="text-zinc-500 hover:text-zinc-200 text-base leading-none px-1"
          title="Close"
        >×</button>
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col">
        {status && !hasEsptool && (
          <div className="px-3 py-2 border-b border-radar-border/40 bg-red-900/20 text-red-300">
            ⚠ <code className="text-red-200">{status.esptool_bin}</code> not on PATH on the Pi. The
            backend can't flash. Run <code>. ~/esp/esp-idf/export.sh</code> in the systemd unit's
            EnvironmentFile, or set <code>RADAR_ESPTOOL</code> to the absolute path of esptool.
          </div>
        )}

        {/* Step 1: upload .bin */}
        <div className="px-3 py-2 border-b border-radar-border/40">
          <div className="text-zinc-400 uppercase tracking-wider mb-1">1 · Upload app .bin</div>
          <div className="text-zinc-600 mb-2">
            Compile locally with <code>idf.py build</code>, then drop
            <code> firmware/build/wifi-radar.bin</code> (or whatever your project name produces).
            Flashed app-only at <code>{status?.app_offset ?? "0x10000"}</code>.
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".bin"
            onChange={onPickFile}
            disabled={uploading || flashing}
            className="block w-full text-zinc-300 file:mr-2 file:py-1 file:px-2 file:rounded file:border file:border-radar-border file:bg-radar-bg/60 file:text-radar-accent file:cursor-pointer hover:file:bg-radar-bg/80"
          />
          {uploading && <div className="text-zinc-500 mt-1">uploading…</div>}
          {uploadErr && <div className="text-red-400 mt-1 break-all">{uploadErr}</div>}
          {upload && (
            <div className="text-emerald-400 mt-1">
              ✓ {upload.filename} ({(upload.size / 1024).toFixed(1)} KiB) — id {upload.file_id.slice(0, 8)}…
            </div>
          )}
        </div>

        {/* Step 2: choose target + flash */}
        <div className="px-3 py-2 border-b border-radar-border/40">
          <div className="text-zinc-400 uppercase tracking-wider mb-1">2 · Target sensor &amp; flash</div>
          {sensorList.length === 0 ? (
            <div className="text-zinc-500">No live sensors detected on the backend.</div>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={targetSid}
                onChange={(e) => setTargetSid(e.target.value)}
                disabled={flashing}
                className="bg-radar-bg/60 border border-radar-border rounded px-1.5 py-1 text-zinc-200 outline-none focus:border-radar-accent"
              >
                {sensorList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id} {s.connected ? "" : "(offline)"}
                  </option>
                ))}
              </select>
              <button
                onClick={flash}
                disabled={!upload || !targetSid || flashing || !hasEsptool}
                className="px-3 py-1 rounded border border-radar-accent text-radar-accent hover:bg-radar-accent/10 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {flashing ? "flashing…" : "🔥 flash"}
              </button>
              {done === "ok" && <span className="text-emerald-400">✓ done</span>}
              {done === "err" && <span className="text-red-400">✗ failed</span>}
            </div>
          )}
          <div className="text-zinc-600 mt-1">
            The reader is suspended on this port for ~30 s while esptool runs, so other sensors keep streaming.
          </div>
        </div>

        {/* Step 3: live log */}
        {log.length > 0 && (
          <div className="flex-1 flex flex-col min-h-[8rem] border-b border-radar-border/40">
            <div className="px-3 py-1 text-zinc-400 uppercase tracking-wider shrink-0 flex items-center gap-2">
              <span>3 · esptool output</span>
              <button
                onClick={() => setLog([])}
                className="ml-auto text-zinc-500 hover:text-zinc-200 text-[9px]"
              >clear</button>
            </div>
            <div
              ref={logRef}
              className="flex-1 overflow-y-auto px-3 pb-2 text-[10px] leading-relaxed text-zinc-300 whitespace-pre-wrap break-all"
            >
              {log.map((l, i) => {
                const cls =
                  l.startsWith("FLASH_OK") ? "text-emerald-400" :
                  l.startsWith("FLASH_ERROR") ? "text-red-400" :
                  l.startsWith("$ ") ? "text-radar-accent" :
                  l.startsWith("[supervisor]") ? "text-zinc-500" : "";
                return <div key={i} className={cls}>{l}</div>;
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
