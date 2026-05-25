import { useMemo } from "react";
import { useStore } from "../store";
import { computeTrilatDebug } from "../lib/trilaterationDebug";

interface Props {
  onClose: () => void;
}

function fmt(n: number, p = 2): string {
  if (!isFinite(n)) return "∞";
  return n.toFixed(p);
}

export function TrilaterationDebug({ onClose }: Props) {
  const selectedMac = useStore((s) => s.selectedMac);
  const devices = useStore((s) => s.devices);
  const sensors = useStore((s) => s.sensors);
  const device = selectedMac ? devices.get(selectedMac) : null;

  const debug = useMemo(() => {
    if (!device) return null;
    return computeTrilatDebug(device, sensors);
  }, [device, sensors]);

  if (!device || !debug) return null;

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-radar-panel border border-radar-border rounded-lg shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2 border-b border-radar-border bg-radar-accent/10 shrink-0">
          <span className="text-radar-accent">🔍</span>
          <div className="flex-1">
            <div className="text-sm font-semibold text-zinc-100">Trilateration step-by-step</div>
            <div className="text-[10px] text-zinc-400 font-mono">{device.mac} · {device.vendor}</div>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 text-xl leading-none px-2"
            aria-label="Close"
          >×</button>
        </div>

        <div className="p-4 space-y-4 text-xs flex-1 overflow-y-auto">
          <section>
            <h3 className="text-[11px] uppercase tracking-wider text-radar-accent mb-2">1. Observations capteurs</h3>
            <p className="text-zinc-400 mb-2 leading-relaxed">
              Chaque capteur rapporte le RSSI le plus récent qu'il a mesuré pour cette MAC.
              Un capteur est considéré « frais » si sa dernière observation a moins de 8 s,
              sinon il est ignoré pour le calcul.
            </p>
            <div className="bg-radar-bg border border-radar-border rounded">
              <table className="w-full font-mono">
                <thead className="text-[10px] text-zinc-500 border-b border-radar-border">
                  <tr>
                    <th className="px-2 py-1 text-left">capteur</th>
                    <th className="px-2 py-1 text-right">position (x, z) m</th>
                    <th className="px-2 py-1 text-right">RSSI</th>
                    <th className="px-2 py-1 text-right">âge</th>
                    <th className="px-2 py-1 text-right">d estimée</th>
                  </tr>
                </thead>
                <tbody className="text-[11px]">
                  {[...debug.fresh, ...debug.stale].map((s) => (
                    <tr key={s.sid} className={`border-b border-radar-border/40 ${s.fresh ? "" : "opacity-40"}`}>
                      <td className="px-2 py-1 text-radar-accent">{s.sid}{!s.fresh && <span className="text-radar-warn ml-1">stale</span>}</td>
                      <td className="px-2 py-1 text-right text-zinc-300">({fmt(s.x)}, {fmt(s.z)})</td>
                      <td className="px-2 py-1 text-right text-zinc-300">{s.rssi} dBm</td>
                      <td className="px-2 py-1 text-right text-zinc-400">{fmt(s.age_s, 1)} s</td>
                      <td className="px-2 py-1 text-right text-zinc-300">{fmt(s.d_est, 2)} m</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h3 className="text-[11px] uppercase tracking-wider text-radar-accent mb-2">2. Modèle path-loss</h3>
            <p className="text-zinc-400 leading-relaxed mb-2">
              Convertit chaque RSSI en distance estimée avec un modèle log-distance générique
              indoor 2.4 GHz : <code className="text-radar-warn">RSSI_0 = {debug.pathLoss.rssi0} dBm</code> (à 1 m),
              <code className="text-radar-warn ml-1">n = {debug.pathLoss.n}</code> (exposant pertes).
            </p>
            <pre className="bg-radar-bg border border-radar-border rounded p-2 text-[11px] text-zinc-200 overflow-x-auto">{debug.pathLoss.formula}</pre>
            <p className="text-[10px] text-zinc-500 mt-1">
              Note : ces paramètres ne sont pas calibrés in situ. La distance estimée a souvent ±50 % d'erreur.
            </p>
          </section>

          {debug.fresh.length < 3 ? (
            <section>
              <h3 className="text-[11px] uppercase tracking-wider text-radar-warn mb-2">! Pas de trilatération possible</h3>
              <p className="text-zinc-300">{debug.verdict}</p>
            </section>
          ) : (
            <>
              <section>
                <h3 className="text-[11px] uppercase tracking-wider text-radar-accent mb-2">3. Linéarisation</h3>
                <p className="text-zinc-400 mb-2 leading-relaxed">
                  Chaque capteur donne un cercle <code>(x − xᵢ)² + (z − zᵢ)² = dᵢ²</code>.
                  En soustrayant l'équation du capteur de référence <code className="text-radar-accent">{debug.reference?.sid}</code>,
                  on obtient des équations linéaires en (x, z) :
                </p>
                <pre className="bg-radar-bg border border-radar-border rounded p-2 text-[11px] text-zinc-200 mb-2 overflow-x-auto">
{`2(xᵢ - x_ref)·x + 2(zᵢ - z_ref)·z = (xᵢ² + zᵢ² - dᵢ²) - (x_ref² + z_ref² - d_ref²)`}
                </pre>
                <div className="bg-radar-bg border border-radar-border rounded font-mono text-[11px]">
                  <table className="w-full">
                    <thead className="text-[10px] text-zinc-500 border-b border-radar-border">
                      <tr>
                        <th className="px-2 py-1 text-left">vs ref</th>
                        <th className="px-2 py-1 text-right">a₀ (×x)</th>
                        <th className="px-2 py-1 text-right">a₁ (×z)</th>
                        <th className="px-2 py-1 text-right">= b</th>
                      </tr>
                    </thead>
                    <tbody>
                      {debug.rows.map((r) => (
                        <tr key={r.sid} className="border-b border-radar-border/40">
                          <td className="px-2 py-1 text-radar-accent">{r.sid}</td>
                          <td className="px-2 py-1 text-right text-zinc-300">{fmt(r.a0, 3)}</td>
                          <td className="px-2 py-1 text-right text-zinc-300">{fmt(r.a1, 3)}</td>
                          <td className="px-2 py-1 text-right text-zinc-300">{fmt(r.b, 3)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {debug.normal && (
                <section>
                  <h3 className="text-[11px] uppercase tracking-wider text-radar-accent mb-2">4. Équations normales (AᵀA)·v = Aᵀb</h3>
                  <p className="text-zinc-400 mb-2 leading-relaxed">
                    Le système est surdéterminé (3+ équations, 2 inconnues). On le résout au sens des moindres carrés
                    en multipliant par Aᵀ des deux côtés. La matrice <code>AᵀA</code> est 2×2 donc inversée à la main.
                  </p>
                  <pre className="bg-radar-bg border border-radar-border rounded p-2 text-[11px] text-zinc-200 overflow-x-auto">
{`AᵀA  =  [ ${fmt(debug.normal.ata00, 3)}  ${fmt(debug.normal.ata01, 3)} ]
        [ ${fmt(debug.normal.ata01, 3)}  ${fmt(debug.normal.ata11, 3)} ]
Aᵀb  =  [ ${fmt(debug.normal.atb0, 3)} ; ${fmt(debug.normal.atb1, 3)} ]
det  =  ${fmt(debug.normal.det, 4)}`}
                  </pre>
                </section>
              )}

              {debug.solution && (
                <section>
                  <h3 className="text-[11px] uppercase tracking-wider text-radar-accent mb-2">5. Solution</h3>
                  <div className="bg-radar-accent/10 border border-radar-accent/40 rounded p-3 text-center">
                    <div className="text-zinc-400 text-[10px] mb-1">position estimée</div>
                    <div className="text-radar-accent font-mono text-lg">
                      ⟨ {fmt(debug.solution.x)} , {fmt(debug.solution.z)} ⟩ m
                    </div>
                  </div>
                </section>
              )}

              {debug.perSensorResidual.length > 0 && (
                <section>
                  <h3 className="text-[11px] uppercase tracking-wider text-radar-accent mb-2">6. Vérification résidus</h3>
                  <p className="text-zinc-400 mb-2 leading-relaxed">
                    Pour chaque capteur : distance réelle de la solution (x, z) au capteur, vs distance qu'on avait
                    estimée par RSSI. Idéalement les deux sont proches.
                  </p>
                  <div className="bg-radar-bg border border-radar-border rounded font-mono text-[11px]">
                    <table className="w-full">
                      <thead className="text-[10px] text-zinc-500 border-b border-radar-border">
                        <tr>
                          <th className="px-2 py-1 text-left">capteur</th>
                          <th className="px-2 py-1 text-right">d réelle</th>
                          <th className="px-2 py-1 text-right">d estimée</th>
                          <th className="px-2 py-1 text-right">écart</th>
                        </tr>
                      </thead>
                      <tbody>
                        {debug.perSensorResidual.map((r) => (
                          <tr key={r.sid} className="border-b border-radar-border/40">
                            <td className="px-2 py-1 text-radar-accent">{r.sid}</td>
                            <td className="px-2 py-1 text-right text-zinc-300">{fmt(r.actual_d, 2)} m</td>
                            <td className="px-2 py-1 text-right text-zinc-300">{fmt(r.expected_d, 2)} m</td>
                            <td className={`px-2 py-1 text-right font-semibold ${Math.abs(r.diff) < 2 ? "text-emerald-400" : Math.abs(r.diff) < 5 ? "text-radar-warn" : "text-radar-danger"}`}>
                              {r.diff > 0 ? "+" : ""}{fmt(r.diff, 2)} m
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-2 text-[11px] flex gap-4">
                    <span><span className="text-zinc-500">RMS </span><span className="text-zinc-200 font-mono">{fmt(debug.rms, 2)} m</span></span>
                    <span><span className="text-zinc-500">confiance </span><span className="text-zinc-200 font-mono">{(debug.confidence * 100).toFixed(0)} %</span></span>
                  </div>
                </section>
              )}

              <section>
                <h3 className="text-[11px] uppercase tracking-wider text-radar-accent mb-2">Verdict</h3>
                <p className="text-zinc-200 leading-relaxed">{debug.verdict}</p>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
