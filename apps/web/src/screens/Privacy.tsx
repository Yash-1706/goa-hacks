import { useEffect, useRef } from "react";
import { Audit } from "@/components/privacy/Audit";
import { Controls } from "@/components/privacy/Controls";
import { DataFlow } from "@/components/privacy/DataFlow";
import { KillSwitch } from "@/components/privacy/KillSwitch";
import { Ledger } from "@/components/privacy/Ledger";
import { Pairing } from "@/components/privacy/Pairing";
import { Retention } from "@/components/privacy/Retention";
import { useFetch } from "@/hooks/useFetch";
import { api } from "@/net/api";
import { usePrivacy } from "@/state/privacy";
import { useThoughts } from "@/state/thoughts";

/**
 * Privacy Center (PRD §6.6): the pause control, what leaves the device, how memory works, purge / local-only /
 * export controls, the ledger of EVERYTHING stored, the audit chain and device pairing.
 */
export default function Privacy() {
  const ledger = useFetch((s) => api.ledger(s), []);
  const audit = useFetch((s) => api.audit(s), []);

  // keep the ledger and audit trail honest while things change underneath (new thoughts, pause, forget, expiry)
  const thoughtCount = useThoughts((s) => s.order.length);
  const paused = usePrivacy((s) => s.paused);
  const forgot = usePrivacy((s) => s.lastForgot);
  const purged = usePrivacy((s) => s.lastPurged);
  const reloadLedger = ledger.reload;
  const reloadAudit = audit.reload;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const id = setTimeout(() => {
      reloadLedger();
      reloadAudit();
    }, 1200);
    return () => clearTimeout(id);
  }, [thoughtCount, paused, forgot, purged, reloadLedger, reloadAudit]);

  const changed = (): void => {
    ledger.reload();
    audit.reload();
  };

  return (
    <div className="page">
      <div className="page__inner">
        <header className="page__head">
          <div>
            <h1 className="page__title">
              <span className="grad-text">Privacy Center</span>
            </h1>
            <p className="page__sub">Draft-first. Forget by default. The mic is sacred. Everything Synapse knows about you is listed below, with the reason it is kept and the time it will be forgotten.</p>
          </div>
        </header>

        <KillSwitch />

        <div className="section">
          <DataFlow />
        </div>

        <div className="section">
          <Retention ledger={ledger.data} />
        </div>

        <div className="section grid-2">
          <Controls localOnly={ledger.data?.localOnly ?? false} onChanged={changed} />
          <Pairing />
        </div>

        <div className="section">
          <Ledger
            ledger={ledger.data}
            loading={ledger.loading}
            onChanged={changed}
            onRemoved={(id) => ledger.setData((p) => (p ? { ...p, items: p.items.filter((i) => i.id !== id) } : p))}
          />
        </div>

        <div className="section">
          <Audit data={audit.data} onReload={audit.reload} />
        </div>
      </div>
    </div>
  );
}
