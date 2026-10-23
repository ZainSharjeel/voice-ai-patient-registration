import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { API_BASE_URL, PHONE_NUMBER, REPO_URL } from "@/lib/intake";

type Row = Record<string, string | null>;
type Call = {
  call_id: string; patient_id: string | null; caller_number: string | null; outcome: string;
  ended_reason: string | null; summary: string | null; transcript: string | null;
  duration_seconds: number | null; created_at: string;
};

const mono = { fontFamily: "var(--font-data)" };
const fmtPhone = (p: string | null) => (p && p.length === 10 ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : (p ?? "—"));
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const OUTCOME: Record<string, { label: string; cls: string }> = {
  registered: { label: "Registered", cls: "bg-emerald-100 text-emerald-900" },
  updated: { label: "Updated", cls: "bg-sky-100 text-sky-900" },
  incomplete: { label: "Incomplete", cls: "bg-amber-100 text-amber-900" },
  in_progress: { label: "On call", cls: "bg-stone-200 text-stone-800" },
};

export function PublicLandingPage() {
  const data = useQuery(api.dashboard.overview);
  const [open, setOpen] = useState<string | null>(null);
  const patients = (data?.patients ?? []) as Row[];
  const calls = (data?.calls ?? []) as Call[];
  const names = new Map(patients.map((p) => [p.patient_id, `${p.first_name} ${p.last_name}`]));
  const registered = calls.filter((c) => c.outcome === "registered").length;

  return (
    <div className="min-h-screen bg-[#f6f4ef] text-stone-900">
      {/* Signature element: the live intake line, the one thing a reviewer needs first. */}
      <header className="bg-[#14302b] text-[#f6f4ef]">
        <div className="mx-auto max-w-6xl px-6 py-10 grid gap-8 md:grid-cols-[1.4fr_1fr] md:items-end">
          <div>
            <p className="text-sm text-emerald-200/80">CareCloud Family Medicine · Voice AI intake</p>
            <h1 className="mt-3 text-4xl md:text-5xl font-semibold tracking-tight leading-[1.05]">
              New-patient registration,<br />answered by Ava.
            </h1>
            <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-stone-300">
              Call the number, register as a new patient in English or Spanish, and watch the record and the call
              transcript appear below in real time.
            </p>
          </div>
          <div className="rounded-xl bg-[#f6f4ef] text-stone-900 p-6">
            <p className="text-sm text-stone-600">Call the intake line</p>
            <a href={`tel:${PHONE_NUMBER.replace(/[^+\d]/g, "")}`} className="mt-1 block text-3xl font-medium tracking-tight hover:underline" style={mono}>
              {PHONE_NUMBER}
            </a>
            <dl className="mt-4 space-y-1 text-[13px] text-stone-600">
              <div className="flex justify-between gap-4"><dt>REST API</dt><dd className="truncate" style={mono}>{API_BASE_URL}</dd></div>
              <div className="flex justify-between gap-4"><dt>Source</dt><dd><a className="underline" href={REPO_URL}>GitHub</a></dd></div>
            </dl>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-8">
        <section aria-label="Totals" className="grid grid-cols-3 gap-px bg-stone-300 rounded-xl overflow-hidden">
          {[
            ["Active patients", patients.length],
            ["Calls handled", calls.length],
            ["Registered by phone", registered],
          ].map(([label, value]) => (
            <div key={label} className="bg-white px-5 py-4">
              <p className="text-[13px] text-stone-500">{label}</p>
              <p className="mt-1 text-3xl font-semibold tabular-nums">{data ? value : "–"}</p>
            </div>
          ))}
        </section>

        <div className="mt-8 grid gap-8 lg:grid-cols-[1.5fr_1fr]">
          <section aria-labelledby="patients-h">
            <h2 id="patients-h" className="text-lg font-semibold">Patients</h2>
            <div className="mt-3 overflow-x-auto rounded-xl bg-white">
              <table className="w-full text-left text-sm">
                <thead className="text-[13px] text-stone-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">Name</th>
                    <th className="px-4 py-3 font-medium">DOB</th>
                    <th className="px-4 py-3 font-medium">Phone</th>
                    <th className="px-4 py-3 font-medium">Location</th>
                    <th className="px-4 py-3 font-medium">Language</th>
                  </tr>
                </thead>
                <tbody>
                  {patients.map((p) => (
                    <tr key={p.patient_id} className="border-t border-stone-100 align-top">
                      <td className="px-4 py-3">
                        <p className="font-medium">{p.first_name} {p.last_name}</p>
                        <p className="text-[12px] text-stone-500">{p.insurance_provider ? `${p.insurance_provider} · ${p.insurance_member_id ?? ""}` : "No insurance on file"}</p>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap" style={mono}>{p.date_of_birth}</td>
                      <td className="px-4 py-3 whitespace-nowrap" style={mono}>{fmtPhone(p.phone_number)}</td>
                      <td className="px-4 py-3">{p.city}, {p.state} <span className="text-stone-500" style={mono}>{p.zip_code}</span></td>
                      <td className="px-4 py-3">{p.preferred_language}</td>
                    </tr>
                  ))}
                  {data && patients.length === 0 && (
                    <tr><td colSpan={5} className="px-4 py-10 text-center text-stone-500">No patients yet. Call the line to register the first one.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="calls-h">
            <h2 id="calls-h" className="text-lg font-semibold">Recent calls</h2>
            <ul className="mt-3 space-y-2">
              {calls.map((c) => {
                const o = OUTCOME[c.outcome] ?? OUTCOME.in_progress;
                const isOpen = open === c.call_id;
                return (
                  <li key={c.call_id} className="rounded-xl bg-white">
                    <button type="button" onClick={() => setOpen(isOpen ? null : c.call_id)} aria-expanded={isOpen}
                      className="w-full px-4 py-3 text-left flex items-start justify-between gap-3 focus-visible:outline-2 focus-visible:outline-emerald-700 rounded-xl">
                      <span>
                        <span className="block font-medium">{(c.patient_id && names.get(c.patient_id)) || c.caller_number || "Unknown caller"}</span>
                        <span className="block text-[12px] text-stone-500">
                          {fmtTime(c.created_at)}{c.duration_seconds ? ` · ${Math.round(c.duration_seconds / 60)} min` : ""}
                        </span>
                      </span>
                      <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[12px] font-medium ${o.cls}`}>{o.label}</span>
                    </button>
                    {isOpen && (
                      <div className="px-4 pb-4 text-sm">
                        {c.summary && <p className="text-stone-700">{c.summary}</p>}
                        <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-[12px] leading-relaxed text-stone-700" style={mono}>
                          {c.transcript ?? "Transcript arrives when the call ends."}
                        </pre>
                      </div>
                    )}
                  </li>
                );
              })}
              {data && calls.length === 0 && <li className="rounded-xl bg-white px-4 py-10 text-center text-stone-500">No calls yet.</li>}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
