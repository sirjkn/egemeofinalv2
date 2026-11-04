import React, { useState, useMemo, useEffect } from "react";
import {
  Calendar, MapPin, Users, BarChart2,
  Plus, Search, Edit2, X, TrendingUp, TrendingDown,
  ChevronLeft, ChevronRight, Target, Activity, Trash2, Eye, AlertTriangle,
  ClipboardList, PhoneCall, Loader2,
} from "lucide-react";
import {
  BarChart as RechartBarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { fmtKES, fmtKESFull, fmtDate } from "@/app/shared";
import { supabase } from "@/lib/supabase";
import { logActivity } from "@/lib/api";
import { OutreachEntryModal } from "@/app/components/OutreachEntryModal";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LeadEvent {
  id: number;
  name: string;
  location: string;
  nature: string;
  contacts: number;
  marketingPax: number;
  budget: number;
  date: string; // ISO
}

interface Lead {
  id: number;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  eventId: number;
  note: string;
  status: PipelineStatus;
  siteVisitDate?: string; // ISO date, only relevant when status = "site_scheduled"
}

interface LeadContactOption {
  id: number;
  name: string;
  phone: string;
}

interface LeadProjectOption {
  id: number;
  name: string;
  location: string;
}

interface SiteVisit {
  id: number;
  projectId: number | null;
  projectName: string;
  location: string;
  scheduledAt: string;
  capacity: number;
  contacts: number | null;
  details: string;
  reportedBy: string;
}

interface OutreachLog {
  id: number;
  occurredAt: string;
  activityType: string;
  contactId: number;
  contactName: string;
  contactPhone: string;
  outcome: string;
  status: string;
  reportedBy: string;
  projectName: string;
  siteVisitLabel: string;
  notes: string;
  activitySubtype: string;
  pipelineStage: string;
  nextFollowup: string;
  followupType: string;
  assignedTo: string;
  assignedToName: string;
  sourceTag: string;
}

type PipelineStatus = "contacts" | "contacted" | "site_scheduled" | "converted" | "lost";

const PIPELINE_STAGES: { id: PipelineStatus; label: string; color: string; bg: string }[] = [
  { id: "contacts",       label: "CONTACTS (New)",  color: "#64748b", bg: "#f1f5f9" },
  { id: "contacted",      label: "CONTACTED",        color: "#f97316", bg: "#fff7ed" },
  { id: "site_scheduled", label: "SITE SCHEDULED",   color: "#3b82f6", bg: "#eff6ff" },
  { id: "converted",      label: "CONVERTED",        color: "#0f9d8f", bg: "#f0fdfc" },
  { id: "lost",           label: "LOST / DEAD",      color: "#ef4444", bg: "#fef2f2" },
];

const STATUS_BADGE: Record<PipelineStatus, { label: string; color: string; border: string }> = {
  contacts:       { label: "CONTACTS",       color: "#64748b", border: "#cbd5e1" },
  contacted:      { label: "CONTACTED",      color: "#f97316", border: "#fed7aa" },
  site_scheduled: { label: "SITE SCHEDULED", color: "#3b82f6", border: "#bfdbfe" },
  converted:      { label: "CONVERTED",      color: "#0f9d8f", border: "#99f6e4" },
  lost:           { label: "LOST / DEAD",    color: "#ef4444", border: "#fecaca" },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DAY_LABELS  = ["S","M","T","W","T","F","S"];

function toDateTimeLocal(date = new Date()) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 16);
}

function displayDateTime(value: string) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-KE", {
    timeZone: "Africa/Nairobi",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function useLeadDirectory() {
  const [contacts, setContacts] = useState<LeadContactOption[]>([]);
  const [projects, setProjects] = useState<LeadProjectOption[]>([]);
  const [reporter, setReporter] = useState("Logged-in User");

  useEffect(() => {
    Promise.all([
      supabase.from("lead_contacts").select("id, first_name, last_name, phone").order("first_name"),
      supabase.from("projects").select("id, project_name, location").order("project_name"),
      supabase.auth.getUser(),
    ]).then(async ([contactResult, projectResult, authResult]) => {
      setContacts((contactResult.data ?? []).map((row: any) => ({
        id: row.id,
        name: `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || `Contact #${row.id}`,
        phone: row.phone ?? "",
      })));
      setProjects((projectResult.data ?? []).map((row: any) => ({
        id: row.id,
        name: row.project_name ?? `Project #${row.id}`,
        location: row.location ?? "",
      })));
      const user = authResult.data.user;
      if (!user) return;
      const { data: profile } = await supabase
        .from("user_profiles")
        .select("full_name, role")
        .eq("id", user.id)
        .maybeSingle();
      if (profile?.full_name) {
        const role = profile.role ? ` (${String(profile.role).replace(/^./, (c) => c.toUpperCase())})` : "";
        setReporter(`${profile.full_name}${role}`);
      } else {
        setReporter(user.email ?? "Logged-in User");
      }
    }).catch(() => {});
  }, []);

  return { contacts, projects, reporter };
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}
function getFirstDayOfWeek(year: number, month: number) {
  return new Date(year, month, 1).getDay();
}

// ─── Mini Calendar Cell ───────────────────────────────────────────────────────

function MonthCalendar({ year, month, eventDates }: { year: number; month: number; eventDates: Set<string> }) {
  const days     = getDaysInMonth(year, month);
  const startDOW = getFirstDayOfWeek(year, month);
  const cells: (number | null)[] = Array(startDOW).fill(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const eventCount = Array.from(eventDates).filter((d) => {
    const date = new Date(d);
    return date.getFullYear() === year && date.getMonth() === month;
  }).length;

  return (
    <div className="bg-white rounded-lg border p-2.5" style={{ borderColor: "#e2e8f0" }}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color: "#172033" }}>
          {MONTH_NAMES[month]}
        </span>
        {eventCount > 0 && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: "#7c3aed", color: "#fff" }}>
            {eventCount}
          </span>
        )}
      </div>
      <div className="grid grid-cols-7 gap-px mb-0.5">
        {DAY_LABELS.map((d, i) => (
          <div key={i} className="text-center text-[9px] font-semibold" style={{ color: "#94a3b8" }}>{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px">
        {cells.map((day, i) => {
          if (!day) return <div key={i} />;
          const iso     = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const hasEvent = eventDates.has(iso);
          return (
            <div
              key={i}
              className="flex items-center justify-center rounded"
              style={{
                height: 16, fontSize: 9,
                fontWeight: hasEvent ? 700 : 400,
                background: hasEvent ? "#7c3aed" : "transparent",
                color: hasEvent ? "#fff" : "#334155",
              }}
            >
              {day}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Events Section ───────────────────────────────────────────────────────────

const EMPTY_EVENT: Omit<LeadEvent, "id"> = {
  name: "", location: "", nature: "", contacts: 0, marketingPax: 0, budget: 0, date: "",
};

function EventsSection() {
  const [calYear,      setCalYear]      = useState(new Date().getFullYear());
  const [events,       setEvents]       = useState<LeadEvent[]>([]);
  const [editing,      setEditing]      = useState<LeadEvent | null>(null);
  const [formData,     setFormData]     = useState<Omit<LeadEvent, "id">>(EMPTY_EVENT);
  const [modalOpen,    setModalOpen]    = useState(false);
  const [saving,       setSaving]       = useState(false);
  const [saveErr,      setSaveErr]      = useState("");
  const [viewEvent,    setViewEvent]    = useState<LeadEvent | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LeadEvent | null>(null);
  const [deleting,     setDeleting]     = useState(false);

  // Load events from DB — no seed fallback so deletes are permanent
  useEffect(() => {
    supabase.from("lead_events").select("*").order("date").then(({ data }) => {
      setEvents((data ?? []).map((r: any) => ({
        id:           r.id,
        name:         r.name,
        location:     r.location,
        nature:       r.nature,
        contacts:     Number(r.contacts ?? 0),
        marketingPax: Number(r.marketing_pax ?? 0),
        budget:       Number(r.budget ?? 0),
        date:         r.date,
      })));
    }).catch(() => { setEvents([]); });
  }, []);

  const eventDates = useMemo(() => new Set(events.map((e) => e.date)), [events]);

  const openCreate = () => {
    setEditing(null);
    setFormData(EMPTY_EVENT);
    setSaveErr("");
    setModalOpen(true);
  };
  const openEdit = (ev: LeadEvent) => {
    setEditing(ev);
    setFormData({ name: ev.name, location: ev.location, nature: ev.nature, contacts: ev.contacts, marketingPax: ev.marketingPax, budget: ev.budget, date: ev.date });
    setSaveErr("");
    setModalOpen(true);
  };

  const handleSave = async () => {
    setSaveErr("");
    if (!formData.name.trim()) { setSaveErr("Event name is required."); return; }
    if (!formData.date)        { setSaveErr("Event date is required."); return; }
    setSaving(true);
    const dbRow = {
      name:          formData.name,
      location:      formData.location,
      nature:        formData.nature,
      contacts:      formData.contacts,
      marketing_pax: formData.marketingPax,
      budget:        formData.budget,
      date:          formData.date,
    };
    try {
      if (editing) {
        const { data, error } = await supabase.from("lead_events").update(dbRow).eq("id", editing.id).select().maybeSingle();
        if (error) throw error;
        const updated: LeadEvent = data
          ? { id: data.id, name: data.name, location: data.location, nature: data.nature, contacts: Number(data.contacts), marketingPax: Number(data.marketing_pax), budget: Number(data.budget), date: data.date }
          : { ...editing, ...formData };
        setEvents((prev) => prev.map((e) => e.id === editing.id ? updated : e));
      } else {
        const { data, error } = await supabase.from("lead_events").insert(dbRow).select().maybeSingle();
        if (error) throw error;
        const nextId = data?.id ?? (Math.max(0, ...events.map((e) => e.id)) + 1);
        setEvents((prev) => [...prev, { id: nextId, ...formData }]);
      }
      setModalOpen(false);
    } catch (err: any) {
      setSaveErr(err?.message ?? "Failed to save. Check that the lead_events table exists in Supabase.");
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await supabase.from("lead_events").delete().eq("id", deleteTarget.id);
      setEvents((prev) => prev.filter((e) => e.id !== deleteTarget.id));
      logActivity({ category: "other", action: "delete", description: `Event "${deleteTarget.name}" deleted`, meta: { event_id: deleteTarget.id } });
    } catch { /* still remove from local state */ }
    setDeleting(false);
    setDeleteTarget(null);
  };

  const totals = useMemo(() => ({
    events:    events.length,
    locations: new Set(events.map((e) => e.location)).size,
    contacts:  events.reduce((s, e) => s + e.contacts, 0),
    budget:    events.reduce((s, e) => s + e.budget, 0),
    avgPax:    events.length ? Math.round(events.reduce((s, e) => s + e.marketingPax, 0) / events.length) : 0,
  }), [events]);

  return (
    <div className="h-full overflow-auto pb-4">
      {/* Title row */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-bold" style={{ color: "#172033" }}>Events Calendar</h2>
          <p className="text-xs mt-0.5" style={{ color: "#64748b" }}>Track your marketing and sales events</p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg text-white transition-colors hover:opacity-90"
          style={{ background: "#0f9d8f" }}
        >
          <Plus size={13} /> New Event
        </button>
      </div>

      {/* Year selector */}
      <div className="flex items-center gap-2 mb-4">
        <span className="text-xs font-semibold" style={{ color: "#64748b" }}>Year:</span>
        <div className="flex items-center gap-1">
          <button onClick={() => setCalYear((y) => y - 1)} className="p-1 rounded hover:bg-gray-100"><ChevronLeft size={14} /></button>
          <span className="text-sm font-bold px-2" style={{ color: "#7c3aed" }}>{calYear}</span>
          <button onClick={() => setCalYear((y) => y + 1)} className="p-1 rounded hover:bg-gray-100"><ChevronRight size={14} /></button>
        </div>
      </div>

      {/* Calendar — only months that have events in selected year */}
      {(() => {
        const activeMonths = Array.from({ length: 12 }, (_, m) => m).filter((m) =>
          Array.from(eventDates).some((d) => {
            const dt = new Date(d);
            return dt.getFullYear() === calYear && dt.getMonth() === m;
          })
        );
        return activeMonths.length === 0 ? (
          <div className="flex items-center gap-3 mb-5 p-4 rounded-lg border" style={{ borderColor: "#e2e8f0", background: "#f8fafc" }}>
            <Calendar size={20} color="#cbd5e1" />
            <p className="text-xs" style={{ color: "#94a3b8" }}>No events recorded for {calYear}. Add an event to see the calendar.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-5">
            {activeMonths.map((m) => (
              <MonthCalendar key={m} year={calYear} month={m} eventDates={eventDates} />
            ))}
          </div>
        );
      })()}

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
        {[
          { label: "TOTAL EVENTS",     value: totals.events,    accent: "#7c3aed", fmt: (v: number) => String(v) },
          { label: "TOTAL LOCATIONS",  value: totals.locations, accent: "#3b82f6", fmt: (v: number) => String(v) },
          { label: "TOTAL CONTACTS",   value: totals.contacts,  accent: "#0f9d8f", fmt: (v: number) => String(v) },
          { label: "TOTAL BUDGET",     value: totals.budget,    accent: "#f97316", fmt: (v: number) => fmtKES(v) },
          { label: "AVG MARKETING PAX",value: totals.avgPax,    accent: "#10b981", fmt: (v: number) => String(v) },
        ].map(({ label, value, accent, fmt }) => (
          <div key={label} className="bg-white rounded-lg border overflow-hidden" style={{ borderColor: "#e2e8f0" }}>
            <div className="h-1" style={{ background: accent }} />
            <div className="p-3">
              <div className="text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: "#94a3b8" }}>{label}</div>
              <div className="text-lg font-bold" style={{ color: "#172033" }}>{fmt(value)}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Events Ledger */}
      <div className="bg-white rounded-lg border" style={{ borderColor: "#e2e8f0" }}>
        <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: "#e2e8f0" }}>
          <h3 className="text-sm font-bold" style={{ color: "#172033" }}>Events Ledger</h3>
          <span className="text-xs" style={{ color: "#94a3b8" }}>{events.length} events</span>
        </div>
        {events.length === 0 ? (
          <div className="py-12 text-center">
            <Calendar size={32} className="mx-auto mb-2" color="#cbd5e1" />
            <p className="text-sm font-semibold" style={{ color: "#94a3b8" }}>No events yet</p>
            <p className="text-xs mt-1" style={{ color: "#cbd5e1" }}>Click "New Event" to add your first marketing event</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ background: "#f8fafc" }}>
                  {["NAME","LOCATION","NATURE OF EVENT","NO. CONTACTS","BUDGET","DATE","ACTION"].map((h) => (
                    <th key={h} className="text-left px-4 py-2.5 font-semibold uppercase tracking-wide text-[10px] whitespace-nowrap" style={{ color: "#94a3b8" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {events.slice().sort((a, b) => a.date.localeCompare(b.date)).map((ev) => (
                  <tr key={ev.id} className="border-t hover:bg-gray-50 transition-colors" style={{ borderColor: "#f1f5f9" }}>
                    <td className="px-4 py-2.5 font-semibold whitespace-nowrap" style={{ color: "#172033" }}>{ev.name}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap" style={{ color: "#475569" }}>{ev.location}</td>
                    <td className="px-4 py-2.5" style={{ color: "#475569" }}>{ev.nature}</td>
                    <td className="px-4 py-2.5 font-medium" style={{ color: "#7c3aed" }}>{ev.contacts} Leads</td>
                    <td className="px-4 py-2.5 font-medium whitespace-nowrap" style={{ color: "#172033" }}>{fmtKESFull(ev.budget)}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap" style={{ color: "#64748b" }}>{fmtDate(ev.date)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1">
                        <button onClick={() => openEdit(ev)} className="p-1.5 rounded hover:bg-purple-50 transition-colors" title="Edit"><Edit2 size={13} color="#7c3aed" /></button>
                        <button onClick={() => setViewEvent(ev)} className="p-1.5 rounded hover:bg-teal-50 transition-colors" title="View"><Eye size={13} color="#0f9d8f" /></button>
                        <button onClick={() => setDeleteTarget(ev)} className="p-1.5 rounded hover:bg-red-50 transition-colors" title="Delete"><Trash2 size={13} color="#ef4444" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Create / Edit Event Modal ── */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md flex flex-col max-h-[90vh]">
            <div className="px-5 py-4 flex items-center justify-between flex-shrink-0 rounded-t-xl" style={{ background: "#7c3aed" }}>
              <span className="text-sm font-bold text-white uppercase tracking-wide">{editing ? "Edit Event" : "Create New Event"}</span>
              <button onClick={() => setModalOpen(false)}><X size={16} color="#fff" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
              {saveErr && (
                <div className="flex items-start gap-2 p-3 rounded-lg text-xs" style={{ background: "#fef2f2", color: "#991b1b" }}>
                  <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                  {saveErr}
                </div>
              )}
              {([
                { key: "name",         label: "Event Name *",      placeholder: "e.g. Nairobi Plot Expo" },
                { key: "location",     label: "Location",           placeholder: "e.g. KICC, Nairobi" },
                { key: "nature",       label: "Nature of Event",    placeholder: "e.g. Roadshow, Exhibition" },
                { key: "contacts",     label: "No. of Contacts",    placeholder: "Target contacts" },
                { key: "marketingPax", label: "Marketing Pax",      placeholder: "Target attendees" },
                { key: "budget",       label: "Budget (Ksh)",       placeholder: "Estimated cost" },
                { key: "date",         label: "Event Date *",       placeholder: "" },
              ] as { key: keyof typeof formData; label: string; placeholder: string }[]).map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label className="block text-[11px] font-bold uppercase tracking-wide mb-1.5" style={{ color: "#64748b" }}>{label}</label>
                  <input
                    className="w-full text-sm border rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-purple-400"
                    style={{ borderColor: saveErr && (key === "name" || key === "date") && !formData[key] ? "#ef4444" : "#e2e8f0", color: "#172033" }}
                    placeholder={placeholder}
                    value={String(formData[key] ?? "")}
                    type={typeof formData[key] === "number" ? "number" : key === "date" ? "date" : "text"}
                    onChange={(e) => {
                      setSaveErr("");
                      setFormData((p) => ({ ...p, [key]: typeof formData[key] === "number" ? Number(e.target.value) : e.target.value }));
                    }}
                  />
                </div>
              ))}
            </div>
            <div className="p-5 flex gap-3 flex-shrink-0 border-t" style={{ borderColor: "#e2e8f0" }}>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 flex items-center justify-center gap-2 text-sm font-bold py-3 rounded-lg text-white transition-colors hover:opacity-90 disabled:opacity-60"
                style={{ background: "#0f9d8f" }}
              >
                {saving ? "Saving…" : <><Plus size={14} />{editing ? "Update Event" : "Save Event"}</>}
              </button>
              <button
                onClick={() => setModalOpen(false)}
                className="px-5 text-sm font-semibold py-3 rounded-lg border transition-colors hover:bg-gray-50"
                style={{ color: "#64748b", borderColor: "#e2e8f0" }}
              >Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* View Event Modal */}
      {viewEvent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold" style={{ color: "#172033" }}>Event Details</h3>
              <button onClick={() => setViewEvent(null)}><X size={15} color="#94a3b8" /></button>
            </div>
            <div className="flex flex-col">
              {[
                { label: "Event Name",    value: viewEvent.name },
                { label: "Location",      value: viewEvent.location || "—" },
                { label: "Nature",        value: viewEvent.nature || "—" },
                { label: "Contacts",      value: String(viewEvent.contacts) },
                { label: "Marketing Pax", value: String(viewEvent.marketingPax) },
                { label: "Budget",        value: fmtKESFull(viewEvent.budget) },
                { label: "Date",          value: fmtDate(viewEvent.date) },
              ].map(({ label, value }) => (
                <div key={label} className="flex justify-between py-2 border-b" style={{ borderColor: "#f1f5f9" }}>
                  <span className="text-[11px] font-semibold" style={{ color: "#94a3b8" }}>{label}</span>
                  <span className="text-xs font-medium text-right" style={{ color: "#172033" }}>{value}</span>
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={() => { openEdit(viewEvent); setViewEvent(null); }} className="flex-1 text-xs font-bold py-2.5 rounded-lg text-white" style={{ background: "#7c3aed" }}>Edit Event</button>
              <button onClick={() => setViewEvent(null)} className="px-4 text-xs font-semibold py-2.5 rounded-lg border" style={{ color: "#64748b", borderColor: "#e2e8f0" }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                <AlertTriangle size={20} color="#ef4444" />
              </div>
              <div>
                <h3 className="text-sm font-bold" style={{ color: "#172033" }}>Delete Event</h3>
                <p className="text-xs mt-0.5" style={{ color: "#64748b" }}>This action is permanent and cannot be undone.</p>
              </div>
            </div>
            <p className="text-xs mb-5 p-3 rounded-lg" style={{ background: "#fef2f2", color: "#991b1b" }}>
              Permanently delete <strong>"{deleteTarget.name}"</strong>?
            </p>
            <div className="flex gap-2">
              <button onClick={confirmDelete} disabled={deleting} className="flex-1 text-xs font-bold py-2.5 rounded-lg text-white" style={{ background: "#ef4444" }}>
                {deleting ? "Deleting…" : "Yes, Delete"}
              </button>
              <button onClick={() => setDeleteTarget(null)} disabled={deleting} className="px-4 text-xs font-semibold py-2.5 rounded-lg border" style={{ color: "#64748b", borderColor: "#e2e8f0" }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Leads Section ────────────────────────────────────────────────────────────

const YEARS_FILTER = [2021, 2022, 2023, 2024, 2025, 2026];
const MONTHS_SHORT = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

function LeadsSection() {
  const today      = new Date();
  const [selYear,  setSelYear]  = useState(today.getFullYear());
  const [selMonth, setSelMonth] = useState(today.getMonth());
  const [leads,       setLeads]      = useState<Lead[]>([]);
  const [events,      setLeadEvents] = useState<LeadEvent[]>([]);
  const [search,      setSearch]     = useState("");
  const [activeEventFilter, setActiveEventFilter] = useState<number | null>(null);
  const [addOpen,     setAddOpen]    = useState(false);
  const [newLead,     setNewLead]    = useState<Omit<Lead, "id">>({ firstName: "", lastName: "", phone: "", email: "", eventId: 0, note: "", status: "contacts", siteVisitDate: "" });
  const [editOpen,    setEditOpen]   = useState(false);
  const [editTarget,  setEditTarget] = useState<Lead | null>(null);
  const [editForm,    setEditForm]   = useState<Omit<Lead, "id">>({ firstName: "", lastName: "", phone: "", email: "", eventId: 0, note: "", status: "contacts" });
  const [viewTarget,  setViewTarget] = useState<Lead | null>(null);
  const [deleteLeadTarget, setDeleteLeadTarget] = useState<Lead | null>(null);
  const [deletingLead,     setDeletingLead]     = useState(false);

  useEffect(() => {
    supabase.from("lead_events").select("*").order("date").then(({ data }) => {
      setLeadEvents((data ?? []).map((r: any) => ({
        id: r.id, name: r.name, location: r.location, nature: r.nature,
        contacts: Number(r.contacts ?? 0), marketingPax: Number(r.marketing_pax ?? 0),
        budget: Number(r.budget ?? 0), date: r.date,
      })));
    }).catch(() => {});
    supabase.from("lead_contacts").select("*").order("id").then(({ data }) => {
      setLeads((data ?? []).map((r: any) => ({
        id: r.id, firstName: r.first_name, lastName: r.last_name ?? "",
        phone: r.phone ?? "", email: r.email ?? "",
        eventId: Number(r.event_id ?? 0), note: r.note ?? "",
        status: (r.status ?? "contacts") as PipelineStatus,
        siteVisitDate: r.site_visit_date ?? undefined,
      })));
    }).catch(() => {});
  }, []);

  const monthEvents = useMemo(() =>
    events.filter((e) => {
      const d = new Date(e.date);
      return d.getFullYear() === selYear && d.getMonth() === selMonth;
    }),
  [events, selYear, selMonth]);

  const filteredLeads = useMemo(() =>
    leads.filter((l) => {
      if (activeEventFilter !== null && l.eventId !== activeEventFilter) return false;
      const q = search.toLowerCase();
      return !q || `${l.firstName} ${l.lastName} ${l.phone} ${l.email}`.toLowerCase().includes(q);
    }),
  [leads, search, activeEventFilter]);

  const toDbRow = (l: Omit<Lead, "id">) => ({
    first_name: l.firstName, last_name: l.lastName, phone: l.phone,
    email: l.email, event_id: l.eventId || null, note: l.note, status: l.status,
    site_visit_date: l.status === "site_scheduled" ? (l.siteVisitDate || null) : null,
  });

  const addLead = async () => {
    if (!newLead.firstName.trim() || !newLead.phone.trim()) return;
    let insertedId: number | undefined;
    try {
      const { data } = await supabase.from("lead_contacts").insert(toDbRow(newLead)).select().maybeSingle();
      insertedId = data?.id;
    } catch {}
    const nextId = insertedId ?? (Math.max(0, ...leads.map((l) => l.id)) + 1);
    setLeads((prev) => [...prev, { id: nextId, ...newLead }]);
    setAddOpen(false);
    setNewLead({ firstName: "", lastName: "", phone: "", email: "", eventId: 0, note: "", status: "contacts", siteVisitDate: "" });
  };

  const changeStatus = (leadId: number, status: PipelineStatus, siteVisitDate?: string) => {
    const update: Record<string, any> = { status };
    if (status === "site_scheduled") update.site_visit_date = siteVisitDate || null;
    else update.site_visit_date = null;
    setLeads((prev) => prev.map((l) => l.id === leadId ? { ...l, status, siteVisitDate: status === "site_scheduled" ? siteVisitDate : undefined } : l));
    supabase.from("lead_contacts").update(update).eq("id", leadId).then(() => {});
  };

  const openEditLead = (lead: Lead) => {
    setEditTarget(lead);
    setEditForm({ firstName: lead.firstName, lastName: lead.lastName, phone: lead.phone, email: lead.email, eventId: lead.eventId, note: lead.note, status: lead.status, siteVisitDate: lead.siteVisitDate ?? "" });
    setEditOpen(true);
  };
  const saveEditLead = async () => {
    if (!editForm.firstName.trim() || !editForm.phone.trim() || !editTarget) return;
    try { await supabase.from("lead_contacts").update(toDbRow(editForm)).eq("id", editTarget.id); } catch {}
    setLeads((prev) => prev.map((l) => l.id === editTarget.id ? { ...l, ...editForm } : l));
    setEditOpen(false);
    setEditTarget(null);
  };
  const deleteLead  = (lead: Lead) => { setDeleteLeadTarget(lead); };
  const confirmDeleteLead = async () => {
    if (!deleteLeadTarget) return;
    setDeletingLead(true);
    try { await supabase.from("lead_contacts").delete().eq("id", deleteLeadTarget.id); } catch {}
    setLeads((prev) => prev.filter((l) => l.id !== deleteLeadTarget.id));
    logActivity({ category: "other", action: "delete", description: `Lead "${deleteLeadTarget.firstName} ${deleteLeadTarget.lastName}" deleted`, meta: { lead_id: deleteLeadTarget.id } });
    setDeletingLead(false);
    setDeleteLeadTarget(null);
  };

  const getEventName = (id: number) => events.find((e) => e.id === id)?.name ?? "—";

  return (
    <div className="h-full overflow-auto pb-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-bold" style={{ color: "#172033" }}>Leads Tracker & Pipeline</h2>
          <p className="text-xs mt-0.5" style={{ color: "#64748b" }}>Manage and track your sales leads</p>
        </div>
      </div>

      {/* Year Filter */}
      <div className="flex items-center gap-1 flex-wrap mb-2">
        {YEARS_FILTER.map((y) => (
          <button key={y} onClick={() => setSelYear(y)}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors"
            style={{ background: selYear === y ? "#7c3aed" : "white", color: selYear === y ? "#fff" : "#64748b", borderColor: selYear === y ? "#7c3aed" : "#e2e8f0" }}
          >{y}</button>
        ))}
      </div>

      {/* Month Filter */}
      <div className="flex items-center gap-1 flex-wrap mb-4">
        {MONTHS_SHORT.map((m, i) => (
          <button key={m} onClick={() => setSelMonth(i)}
            className="text-[11px] font-bold px-2.5 py-1 rounded border transition-colors"
            style={{ background: selMonth === i ? "#f97316" : "white", color: selMonth === i ? "#fff" : "#64748b", borderColor: selMonth === i ? "#f97316" : "#e2e8f0" }}
          >{m}</button>
        ))}
      </div>

      {/* Event Filter */}
      {monthEvents.length > 0 && (
        <div className="bg-white rounded-lg border p-3 mb-4" style={{ borderColor: "#e2e8f0" }}>
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: "#64748b" }}>
              Events in {MONTHS_SHORT[selMonth]} {selYear}: <span className="normal-case font-normal">(click to filter)</span>
            </p>
            {activeEventFilter !== null && (
              <button onClick={() => setActiveEventFilter(null)}
                className="text-[10px] font-semibold px-2 py-0.5 rounded-full border"
                style={{ color: "#ef4444", borderColor: "#fecaca", background: "#fef2f2" }}
              >Clear filter ×</button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {monthEvents.map((ev, i) => {
              const isActive = activeEventFilter === ev.id;
              return (
                <button key={ev.id} onClick={() => setActiveEventFilter(isActive ? null : ev.id)}
                  className="text-xs px-2.5 py-1 rounded-full font-medium transition-all border"
                  style={isActive
                    ? { background: "#0f9d8f", color: "#fff", borderColor: "#0f9d8f", boxShadow: "0 0 0 2px #0f9d8f40" }
                    : { background: "#f1f5f9", color: "#334155", borderColor: "#e2e8f0" }}
                >
                  {i + 1}: {ev.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Pipeline — horizontal scroll on mobile */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <h3 className="text-sm font-bold" style={{ color: "#172033" }}>Pipeline View (Sales Funnel)</h3>
          {activeEventFilter !== null && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: "#0f9d8f20", color: "#0f9d8f" }}>
              Filtered: {getEventName(activeEventFilter)}
            </span>
          )}
        </div>
        <div className="overflow-x-auto pb-2">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(140px, 1fr))", gap: "12px" }}>
            {PIPELINE_STAGES.map(({ id, label, color, bg }) => {
              const baseLeads   = activeEventFilter !== null ? leads.filter((l) => l.eventId === activeEventFilter) : leads;
              const stageLeads  = baseLeads.filter((l) => l.status === id);
              return (
                <div key={id} className="rounded-lg border overflow-hidden flex-shrink-0" style={{ borderColor: "#e2e8f0" }}>
                  <div className="px-3 py-2" style={{ background: bg, borderBottom: `2px solid ${color}` }}>
                    <span className="text-[10px] font-bold uppercase tracking-wide" style={{ color }}>{label}</span>
                    <span className="ml-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full text-white" style={{ background: color }}>{stageLeads.length}</span>
                  </div>
                  <div className="p-2 flex flex-col gap-1.5 min-h-[100px] bg-white">
                    {stageLeads.map((lead) => (
                      <div key={lead.id} className="rounded border p-2" style={{ borderColor: id === "site_scheduled" ? "#bfdbfe" : "#e2e8f0", background: id === "site_scheduled" ? "#f0f7ff" : "white" }}>
                        <div className="text-[11px] font-semibold" style={{ color: "#172033" }}>{lead.firstName} {lead.lastName}</div>
                        <div className="text-[10px] mt-0.5" style={{ color: "#94a3b8" }}>{lead.phone}</div>
                        {id === "site_scheduled" && (
                          <div className="flex items-center gap-1 mt-1">
                            <Calendar size={9} color="#3b82f6" />
                            <span className="text-[10px] font-semibold" style={{ color: lead.siteVisitDate ? "#1d4ed8" : "#94a3b8" }}>
                              {lead.siteVisitDate ? fmtDate(lead.siteVisitDate) : "No date set"}
                            </span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Search + Add */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="flex-1 min-w-[200px] relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2" color="#94a3b8" />
          <input
            className="w-full text-xs border rounded-lg pl-8 pr-3 py-2 focus:outline-none focus:ring-1 focus:ring-purple-400"
            style={{ borderColor: "#e2e8f0", color: "#172033" }}
            placeholder="Search name, phone, email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button onClick={() => setAddOpen(true)}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg text-white hover:opacity-90"
          style={{ background: "#7c3aed" }}
        ><Plus size={13} /> Add Lead</button>
      </div>

      {/* Add Lead Modal */}
      {addOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold" style={{ color: "#172033" }}>Add New Lead</h3>
              <button onClick={() => setAddOpen(false)}><X size={15} color="#94a3b8" /></button>
            </div>
            <div className="flex flex-col gap-3">
              {([
                { key: "firstName", label: "First Name *", placeholder: "e.g. Olivia" },
                { key: "lastName",  label: "Last Name",    placeholder: "e.g. Auma" },
                { key: "phone",     label: "Phone *",      placeholder: "Any phone number" },
                { key: "email",     label: "Email",        placeholder: "email@example.com" },
              ] as { key: keyof typeof newLead; label: string; placeholder: string }[]).map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label className="block text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: "#64748b" }}>{label}</label>
                  <input
                    className="w-full text-xs border rounded-lg px-2.5 py-2 focus:outline-none focus:ring-1 focus:ring-purple-400"
                    style={{ borderColor: "#e2e8f0" }}
                    placeholder={placeholder}
                    value={String(newLead[key] ?? "")}
                    onChange={(e) => setNewLead((p) => ({ ...p, [key]: e.target.value }))}
                  />
                </div>
              ))}
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: "#64748b" }}>NOTE</label>
                <textarea
                  className="w-full text-xs border rounded-lg px-2.5 py-2 focus:outline-none focus:ring-1 focus:ring-purple-400 resize-y"
                  style={{ borderColor: "#e2e8f0", minHeight: "72px" }}
                  placeholder="Any note..."
                  value={newLead.note}
                  onChange={(e) => setNewLead((p) => ({ ...p, note: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: "#64748b" }}>SOURCE EVENT</label>
                <select
                  className="w-full text-xs border rounded-lg px-2.5 py-2 focus:outline-none focus:ring-1 focus:ring-purple-400"
                  style={{ borderColor: "#e2e8f0" }}
                  value={newLead.eventId}
                  onChange={(e) => setNewLead((p) => ({ ...p, eventId: Number(e.target.value) }))}
                >
                  <option value={0}>— Select Event —</option>
                  {events.map((ev) => <option key={ev.id} value={ev.id}>{ev.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: "#64748b" }}>INITIAL STATUS</label>
                <select className="w-full text-xs border rounded-lg px-2.5 py-2 focus:outline-none focus:ring-1 focus:ring-purple-400" style={{ borderColor: "#e2e8f0" }}
                  value={newLead.status} onChange={(e) => setNewLead((p) => ({ ...p, status: e.target.value as PipelineStatus }))}>
                  {PIPELINE_STAGES.map((s) => <option key={s.id} value={s.id}>{s.label.replace(" (New)", "")}</option>)}
                </select>
              </div>
              {newLead.status === "site_scheduled" && (
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: "#3b82f6" }}>SITE VISIT DATE</label>
                  <input
                    type="date"
                    className="w-full text-xs border rounded-lg px-2.5 py-2 focus:outline-none focus:ring-1 focus:ring-blue-400"
                    style={{ borderColor: "#bfdbfe" }}
                    value={newLead.siteVisitDate ?? ""}
                    onChange={(e) => setNewLead((p) => ({ ...p, siteVisitDate: e.target.value }))}
                  />
                </div>
              )}
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={addLead} className="flex-1 text-xs font-bold py-2.5 rounded-lg text-white" style={{ background: "#7c3aed" }}>Save Lead</button>
              <button onClick={() => setAddOpen(false)} className="px-4 text-xs font-semibold py-2.5 rounded-lg border" style={{ color: "#64748b", borderColor: "#e2e8f0" }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Lead Modal */}
      {editOpen && editTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold" style={{ color: "#172033" }}>Edit Lead</h3>
              <button onClick={() => setEditOpen(false)}><X size={15} color="#94a3b8" /></button>
            </div>
            <div className="flex flex-col gap-3">
              {([
                { key: "firstName", label: "First Name", placeholder: "e.g. Olivia" },
                { key: "lastName",  label: "Last Name",  placeholder: "e.g. Auma" },
                { key: "phone",     label: "Phone",      placeholder: "Any phone number" },
                { key: "email",     label: "Email",      placeholder: "email@example.com" },
              ] as { key: keyof typeof editForm; label: string; placeholder: string }[]).map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label className="block text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: "#64748b" }}>{label}</label>
                  <input
                    className="w-full text-xs border rounded-lg px-2.5 py-2 focus:outline-none focus:ring-1 focus:ring-blue-400"
                    style={{ borderColor: "#e2e8f0" }}
                    placeholder={placeholder}
                    value={String(editForm[key] ?? "")}
                    onChange={(e) => setEditForm((p) => ({ ...p, [key]: e.target.value }))}
                  />
                </div>
              ))}
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: "#64748b" }}>NOTE</label>
                <textarea
                  className="w-full text-xs border rounded-lg px-2.5 py-2 focus:outline-none focus:ring-1 focus:ring-blue-400 resize-y"
                  style={{ borderColor: "#e2e8f0", minHeight: "72px" }}
                  value={editForm.note}
                  onChange={(e) => setEditForm((p) => ({ ...p, note: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: "#64748b" }}>SOURCE EVENT</label>
                <select className="w-full text-xs border rounded-lg px-2.5 py-2 focus:outline-none focus:ring-1 focus:ring-blue-400" style={{ borderColor: "#e2e8f0" }}
                  value={editForm.eventId} onChange={(e) => setEditForm((p) => ({ ...p, eventId: Number(e.target.value) }))}>
                  <option value={0}>— Select Event —</option>
                  {events.map((ev) => <option key={ev.id} value={ev.id}>{ev.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: "#64748b" }}>PIPELINE STATUS</label>
                <select className="w-full text-xs border rounded-lg px-2.5 py-2 focus:outline-none focus:ring-1 focus:ring-blue-400" style={{ borderColor: "#e2e8f0" }}
                  value={editForm.status} onChange={(e) => setEditForm((p) => ({ ...p, status: e.target.value as PipelineStatus }))}>
                  {PIPELINE_STAGES.map((s) => <option key={s.id} value={s.id}>{s.label.replace(" (New)", "")}</option>)}
                </select>
              </div>
              {editForm.status === "site_scheduled" && (
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: "#3b82f6" }}>SITE VISIT DATE</label>
                  <input
                    type="date"
                    className="w-full text-xs border rounded-lg px-2.5 py-2 focus:outline-none focus:ring-1 focus:ring-blue-400"
                    style={{ borderColor: "#bfdbfe" }}
                    value={editForm.siteVisitDate ?? ""}
                    onChange={(e) => setEditForm((p) => ({ ...p, siteVisitDate: e.target.value }))}
                  />
                </div>
              )}
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={saveEditLead} className="flex-1 text-xs font-bold py-2.5 rounded-lg text-white" style={{ background: "#3b82f6" }}>Save Changes</button>
              <button onClick={() => setEditOpen(false)} className="px-4 text-xs font-semibold py-2.5 rounded-lg border" style={{ color: "#64748b", borderColor: "#e2e8f0" }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* View Lead Modal */}
      {viewTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold" style={{ color: "#172033" }}>Lead Details</h3>
              <button onClick={() => setViewTarget(null)}><X size={15} color="#94a3b8" /></button>
            </div>
            <div className="flex flex-col">
              {([
                { label: "Full Name",       value: `${viewTarget.firstName} ${viewTarget.lastName}` },
                { label: "Phone",           value: viewTarget.phone },
                { label: "Email",           value: viewTarget.email || "—" },
                { label: "Source Event",    value: getEventName(viewTarget.eventId) },
                { label: "Note",            value: viewTarget.note || "—" },
                { label: "Pipeline Status", value: STATUS_BADGE[viewTarget.status].label },
                ...(viewTarget.status === "site_scheduled" ? [{ label: "Site Visit Date", value: viewTarget.siteVisitDate ? fmtDate(viewTarget.siteVisitDate) : "Not set" }] : []),
              ] as { label: string; value: string }[]).map(({ label, value }) => (
                <div key={label} className="flex justify-between py-2.5 border-b" style={{ borderColor: "#f1f5f9" }}>
                  <span className="text-[11px] font-semibold flex-shrink-0" style={{ color: label === "Site Visit Date" ? "#3b82f6" : "#94a3b8" }}>{label}</span>
                  <span className="text-xs font-medium text-right ml-4" style={{ color: label === "Site Visit Date" ? "#1d4ed8" : "#172033", wordBreak: "break-word", fontWeight: label === "Site Visit Date" ? 700 : 500 }}>{value}</span>
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={() => { openEditLead(viewTarget); setViewTarget(null); }} className="flex-1 text-xs font-bold py-2.5 rounded-lg text-white" style={{ background: "#3b82f6" }}>Edit Lead</button>
              <button onClick={() => setViewTarget(null)} className="px-4 text-xs font-semibold py-2.5 rounded-lg border" style={{ color: "#64748b", borderColor: "#e2e8f0" }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Leads Ledger */}
      <div className="bg-white rounded-lg border" style={{ borderColor: "#e2e8f0" }}>
        <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: "#e2e8f0" }}>
          <h3 className="text-sm font-bold" style={{ color: "#172033" }}>Leads Output Ledger</h3>
          <span className="text-xs" style={{ color: "#94a3b8" }}>{filteredLeads.length} leads</span>
        </div>
        {filteredLeads.length === 0 ? (
          <div className="py-10 text-center">
            <Users size={28} className="mx-auto mb-2" color="#cbd5e1" />
            <p className="text-sm font-semibold" style={{ color: "#94a3b8" }}>{leads.length === 0 ? "No leads yet" : "No leads match filter"}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ background: "#f8fafc" }}>
                  {["FIRST NAME","LAST NAME","PHONE","EMAIL","SOURCE EVENT","NOTE","STATUS","SITE VISIT","ACTIONS"].map((h) => (
                    <th key={h} className="text-left px-3 py-2.5 font-semibold uppercase tracking-wide text-[10px] whitespace-nowrap" style={{ color: "#94a3b8" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredLeads.map((lead) => {
                  const badge = STATUS_BADGE[lead.status];
                  return (
                    <tr key={lead.id} className="border-t hover:bg-gray-50 transition-colors" style={{ borderColor: "#f1f5f9" }}>
                      <td className="px-3 py-2.5 font-semibold whitespace-nowrap" style={{ color: "#172033" }}>{lead.firstName}</td>
                      <td className="px-3 py-2.5 font-semibold whitespace-nowrap" style={{ color: "#172033" }}>{lead.lastName}</td>
                      <td className="px-3 py-2.5 font-mono whitespace-nowrap" style={{ color: "#475569" }}>{lead.phone}</td>
                      <td className="px-3 py-2.5" style={{ color: "#475569", maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis" }}>{lead.email}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: "#475569" }}>{getEventName(lead.eventId)}</td>
                      <td className="px-3 py-2.5" style={{ color: "#64748b", minWidth: "180px", maxWidth: "280px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{lead.note}</td>
                      <td className="px-3 py-2.5">
                        <select
                          className="text-[11px] font-semibold border rounded px-2 py-0.5 focus:outline-none"
                          style={{ color: badge.color, borderColor: badge.border, background: "white" }}
                          value={lead.status}
                          onChange={(e) => {
                            const s = e.target.value as PipelineStatus;
                            if (s === "site_scheduled") { openEditLead({ ...lead, status: s }); }
                            else changeStatus(lead.id, s);
                          }}
                        >
                          {PIPELINE_STAGES.map((s) => <option key={s.id} value={s.id}>{s.label.replace(" (New)", "")}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {lead.status === "site_scheduled" ? (
                          lead.siteVisitDate
                            ? <span className="text-[11px] font-bold" style={{ color: "#1d4ed8" }}>{fmtDate(lead.siteVisitDate)}</span>
                            : <button onClick={() => openEditLead(lead)} className="text-[10px] font-semibold px-1.5 py-0.5 rounded border" style={{ color: "#3b82f6", borderColor: "#bfdbfe", background: "#eff6ff" }}>Set date</button>
                        ) : (
                          <span style={{ color: "#cbd5e1" }}>—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1">
                          <button onClick={() => openEditLead(lead)} className="p-1.5 rounded hover:bg-blue-50" title="Edit"><Edit2 size={13} color="#3b82f6" /></button>
                          <button onClick={() => setViewTarget(lead)} className="p-1.5 rounded hover:bg-teal-50" title="View"><Eye size={13} color="#0f9d8f" /></button>
                          <button onClick={() => deleteLead(lead)} className="p-1.5 rounded hover:bg-red-50" title="Delete"><Trash2 size={13} color="#ef4444" /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Delete Lead Confirmation */}
      {deleteLeadTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-sm">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle size={18} color="#ef4444" />
              <h3 className="text-sm font-bold" style={{ color: "#172033" }}>Delete Contact</h3>
            </div>
            <p className="text-xs mb-4" style={{ color: "#64748b" }}>
              Permanently delete <strong>{deleteLeadTarget.firstName} {deleteLeadTarget.lastName}</strong>? This cannot be undone.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setDeleteLeadTarget(null)} className="flex-1 text-xs font-semibold py-2 rounded-lg border" style={{ color: "#64748b", borderColor: "#e2e8f0" }}>Cancel</button>
              <button onClick={confirmDeleteLead} disabled={deletingLead} className="flex-1 text-xs font-semibold py-2 rounded-lg text-white" style={{ background: "#ef4444" }}>
                {deletingLead ? "Deleting…" : "Yes, Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Site Visits Section ─────────────────────────────────────────────────────

function SiteVisitsSection() {
  const { projects, reporter } = useLeadDirectory();
  const [visits, setVisits] = useState<SiteVisit[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [form, setForm] = useState({
    projectId: 0,
    location: "",
    scheduledAt: toDateTimeLocal(),
    capacity: "",
    contacts: "",
    details: "",
  });

  const load = () => {
    setLoading(true);
    supabase
      .from("lead_site_visits")
      .select("*, project:projects(project_name)")
      .order("scheduled_at", { ascending: false })
      .then(({ data, error: loadError }) => {
        if (loadError) throw loadError;
        setVisits((data ?? []).map((row: any) => ({
          id: row.id,
          projectId: row.project_id,
          projectName: row.project?.project_name ?? "",
          location: row.location ?? "",
          scheduledAt: row.scheduled_at,
          capacity: Number(row.capacity ?? 0),
          contacts: row.contacts_count == null ? null : Number(row.contacts_count),
          details: row.details ?? "",
          reportedBy: row.reported_by ?? "—",
        })));
        setError("");
      })
      .catch((err) => setError(err?.message ?? "Unable to load site visits. Run the Leads outreach migration in Supabase."))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const openCreate = () => {
    setEditingId(null);
    setForm({ projectId: 0, location: "", scheduledAt: toDateTimeLocal(), capacity: "", contacts: "", details: "" });
    setError("");
    setModalOpen(true);
  };

  const openEdit = (visit: SiteVisit) => {
    setEditingId(visit.id);
    setForm({
      projectId: visit.projectId ?? 0,
      location: visit.location,
      scheduledAt: toDateTimeLocal(new Date(visit.scheduledAt)),
      capacity: String(visit.capacity),
      contacts: visit.contacts == null ? "" : String(visit.contacts),
      details: visit.details,
    });
    setError("");
    setModalOpen(true);
  };

  const save = async () => {
    if (!form.location.trim() || !form.scheduledAt || !form.capacity || Number(form.capacity) < 1) {
      setError("Location, date/time, and capacity are required.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const { data: auth } = await supabase.auth.getUser();
      const payload = {
        project_id: form.projectId || null,
        location: form.location.trim(),
        scheduled_at: new Date(form.scheduledAt).toISOString(),
        capacity: Number(form.capacity),
        contacts_count: form.contacts === "" ? null : Number(form.contacts),
        details: form.details.trim() || null,
        reported_by: reporter,
        created_by: auth.user?.id ?? null,
      };
      const query = editingId
        ? supabase.from("lead_site_visits").update(payload).eq("id", editingId)
        : supabase.from("lead_site_visits").insert(payload);
      const { error: saveError } = await query;
      if (saveError) throw saveError;
      logActivity({
        category: "other",
        action: editingId ? "update" : "create",
        description: `Site visit ${editingId ? "updated" : "scheduled"} at ${form.location}`,
        actor_name: reporter,
      });
      setModalOpen(false);
      load();
    } catch (err: any) {
      setError(err?.message ?? "Failed to save site visit.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: number) => {
    await supabase.from("lead_site_visits").delete().eq("id", id);
    setVisits((current) => current.filter((visit) => visit.id !== id));
    setDeleteId(null);
  };

  const upcoming = visits.filter((visit) => new Date(visit.scheduledAt).getTime() >= Date.now()).length;
  const totalCapacity = visits.reduce((sum, visit) => sum + visit.capacity, 0);
  const contactsRecorded = visits.reduce((sum, visit) => sum + (visit.contacts ?? 0), 0);

  return (
    <div className="h-full overflow-auto pb-4">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-base font-bold" style={{ color: "#172033" }}>Site Visits</h2>
          <p className="text-xs mt-0.5 text-gray-500">Schedule visits and add attendance figures later.</p>
        </div>
        <button onClick={openCreate} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-violet-600 hover:bg-violet-700">
          <Plus size={13} /> New Site Visit
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-4">
        {[
          { label: "Upcoming", value: upcoming, color: "#7c3aed" },
          { label: "Total Capacity", value: totalCapacity, color: "#2563eb" },
          { label: "Contacts Recorded", value: contactsRecorded, color: "#0f9d8f" },
        ].map((card) => (
          <div key={card.label} className="bg-white rounded-xl border p-4" style={{ borderColor: "#e2e8f0" }}>
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{card.label}</p>
            <p className="text-xl font-extrabold mt-1" style={{ color: card.color }}>{card.value}</p>
          </div>
        ))}
      </div>

      {error && !modalOpen && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800">{error}</div>
      )}

      <div className="bg-white rounded-xl border overflow-hidden" style={{ borderColor: "#e2e8f0" }}>
        {loading ? (
          <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-violet-500" /></div>
        ) : visits.length === 0 ? (
          <div className="py-12 text-center">
            <MapPin size={30} className="mx-auto mb-2 text-gray-300" />
            <p className="text-sm font-semibold text-gray-400">No site visits scheduled</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="bg-slate-50">
                {["LOCATION", "PROJECT", "DATE / TIME", "CAPACITY", "CONTACTS", "REPORTED BY", "ACTION"].map((heading) => (
                  <th key={heading} className="px-4 py-3 text-left text-[10px] font-bold tracking-wide text-gray-400 whitespace-nowrap">{heading}</th>
                ))}
              </tr></thead>
              <tbody>
                {visits.map((visit) => (
                  <tr key={visit.id} className="border-t hover:bg-violet-50/30" style={{ borderColor: "#f1f5f9" }}>
                    <td className="px-4 py-3 font-semibold text-slate-800 whitespace-nowrap">{visit.location}</td>
                    <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{visit.projectName || "—"}</td>
                    <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{displayDateTime(visit.scheduledAt)}</td>
                    <td className="px-4 py-3 font-bold text-blue-600">{visit.capacity}</td>
                    <td className="px-4 py-3">
                      {visit.contacts == null
                        ? <span className="text-[10px] px-2 py-1 rounded-full bg-gray-100 text-gray-500">Add later</span>
                        : <span className="font-bold text-teal-600">{visit.contacts}</span>}
                    </td>
                    <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{visit.reportedBy}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button onClick={() => openEdit(visit)} className="p-1.5 rounded hover:bg-violet-50" title="Edit">
                          <Edit2 size={13} className="text-violet-600" />
                        </button>
                        <button onClick={() => setDeleteId(visit.id)} className="p-1.5 rounded hover:bg-red-50" title="Delete">
                          <Trash2 size={13} className="text-red-500" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
            <div className="px-5 py-4 flex items-center justify-between border-b bg-violet-50 border-violet-100">
              <div>
                <h3 className="font-bold text-base text-slate-900">{editingId ? "Edit Site Visit" : "New Site Visit"}</h3>
                <p className="text-xs text-slate-500">{editingId ? "Update attendance or visit details." : "Schedule capacity now; contacts can be entered later."}</p>
              </div>
              <button onClick={() => setModalOpen(false)} className="p-1.5 rounded-lg hover:bg-violet-100"><X size={16} /></button>
            </div>
            <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
              {error && <div className="sm:col-span-2 px-3 py-2 rounded-lg bg-red-50 text-xs text-red-600">{error}</div>}
              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-gray-500 mb-1">Project (optional)</label>
                <select value={form.projectId} onChange={(e) => {
                  const projectId = Number(e.target.value);
                  const project = projects.find((item) => item.id === projectId);
                  setForm((current) => ({ ...current, projectId, location: project?.location || current.location }));
                }} className="w-full border rounded-xl px-3 py-2.5 text-sm" style={{ borderColor: "#e2e8f0" }}>
                  <option value={0}>Select project or enter a location</option>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name} — {project.location}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Location *</label>
                <input value={form.location} onChange={(e) => setForm((current) => ({ ...current, location: e.target.value }))}
                  placeholder="e.g. Kitengela Phase 2" className="w-full border rounded-xl px-3 py-2.5 text-sm" style={{ borderColor: "#e2e8f0" }} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Date / Time *</label>
                <input type="datetime-local" value={form.scheduledAt} onChange={(e) => setForm((current) => ({ ...current, scheduledAt: e.target.value }))}
                  className="w-full border rounded-xl px-3 py-2.5 text-sm" style={{ borderColor: "#e2e8f0" }} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Capacity *</label>
                <input type="number" min={1} value={form.capacity} onChange={(e) => setForm((current) => ({ ...current, capacity: e.target.value }))}
                  placeholder="Expected visitors" className="w-full border rounded-xl px-3 py-2.5 text-sm" style={{ borderColor: "#e2e8f0" }} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Contacts <span className="font-normal text-gray-400">(optional)</span></label>
                <input type="number" min={0} value={form.contacts} onChange={(e) => setForm((current) => ({ ...current, contacts: e.target.value }))}
                  placeholder="Can be filled later" className="w-full border rounded-xl px-3 py-2.5 text-sm" style={{ borderColor: "#e2e8f0" }} />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-gray-500 mb-1">Visit Details</label>
                <textarea value={form.details} onChange={(e) => setForm((current) => ({ ...current, details: e.target.value }))}
                  rows={3} placeholder="Meeting point, transport, special instructions…" className="w-full border rounded-xl px-3 py-2.5 text-sm resize-none" style={{ borderColor: "#e2e8f0" }} />
              </div>
              <div className="sm:col-span-2 rounded-xl bg-slate-50 px-3 py-2.5">
                <span className="text-[10px] uppercase font-bold text-gray-400">Reported By</span>
                <p className="text-sm font-semibold text-slate-700">{reporter}</p>
              </div>
            </div>
            <div className="px-5 pb-5 flex justify-end gap-2">
              <button onClick={() => setModalOpen(false)} className="px-4 py-2.5 rounded-xl border text-sm font-semibold text-gray-500" style={{ borderColor: "#e2e8f0" }}>Cancel</button>
              <button onClick={save} disabled={saving} className="px-5 py-2.5 rounded-xl text-sm font-bold text-white bg-violet-600 disabled:opacity-50 flex items-center gap-2">
                {saving && <Loader2 size={13} className="animate-spin" />} {editingId ? "Save Changes" : "Save Site Visit"}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteId !== null && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-xs p-5">
            <h3 className="font-bold text-sm text-slate-900">Delete site visit?</h3>
            <p className="text-xs text-gray-500 mt-1 mb-4">Linked outreach records will keep their activity information.</p>
            <div className="flex gap-2">
              <button onClick={() => setDeleteId(null)} className="flex-1 py-2 rounded-lg border text-xs font-semibold text-gray-500">Cancel</button>
              <button onClick={() => remove(deleteId)} className="flex-1 py-2 rounded-lg text-xs font-bold text-white bg-red-600">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Daily Outreach Log ──────────────────────────────────────────────────────

function DailyOutreachSection() {
  const { contacts, projects, reporter } = useLeadDirectory();
  const [siteVisits, setSiteVisits] = useState<SiteVisit[]>([]);
  const [logs, setLogs] = useState<OutreachLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [dateFilter, setDateFilter] = useState(new Date().toISOString().slice(0, 10));
  const [sourceFilter, setSourceFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [followupFilter, setFollowupFilter] = useState("");
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const load = () => {
    setLoading(true);
    Promise.all([
      supabase
        .from("lead_outreach_logs")
        .select("*, contact:lead_contacts(first_name,last_name,phone,event_id), project:projects(project_name), site_visit:lead_site_visits(location,scheduled_at)")
        .order("occurred_at", { ascending: false }),
      supabase
        .from("lead_site_visits")
        .select("*, project:projects(project_name)")
        .order("scheduled_at", { ascending: false }),
    ]).then(([logResult, visitResult]) => {
      if (logResult.error) throw logResult.error;
      if (visitResult.error) throw visitResult.error;
      setLogs((logResult.data ?? []).map((row: any) => ({
        id: row.id,
        occurredAt: row.occurred_at,
        activityType: row.activity_type,
        contactId: row.contact_id,
        contactName: `${row.contact?.first_name ?? ""} ${row.contact?.last_name ?? ""}`.trim() || "—",
        contactPhone: row.contact?.phone ?? "",
        outcome: row.outcome ?? "",
        status: row.status ?? "",
        reportedBy: row.reported_by ?? "—",
        projectName: row.project?.project_name ?? "",
        siteVisitLabel: row.site_visit ? `${row.site_visit.location} · ${displayDateTime(row.site_visit.scheduled_at)}` : "",
        notes: row.notes ?? "",
        activitySubtype: row.activity_subtype ?? "",
        pipelineStage: row.pipeline_stage ?? "",
        nextFollowup: row.followup_at ?? "",
        followupType: row.followup_type ?? "",
        assignedTo: row.assigned_to ?? "",
        assignedToName: row.assigned_to_name ?? "",
        sourceTag: row.contact?.event_id ? "EVENT" : "LEAD",
      })));
      setSiteVisits((visitResult.data ?? []).map((row: any) => ({
        id: row.id,
        projectId: row.project_id,
        projectName: row.project?.project_name ?? "",
        location: row.location,
        scheduledAt: row.scheduled_at,
        capacity: Number(row.capacity ?? 0),
        contacts: row.contacts_count == null ? null : Number(row.contacts_count),
        details: row.details ?? "",
        reportedBy: row.reported_by ?? "",
      })));
      setError("");
    }).catch((err) => setError(err?.message ?? "Unable to load outreach logs. Run the Leads outreach migration in Supabase."))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const openCreate = () => {
    setError("");
    setModalOpen(true);
  };

  const remove = async (id: number) => {
    await supabase.from("lead_outreach_logs").delete().eq("id", id);
    setLogs((current) => current.filter((log) => log.id !== id));
    setDeleteId(null);
  };

  const filtered = logs.filter((log) => {
    const eatDate = new Date(log.occurredAt).toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
    if (dateFilter && eatDate !== dateFilter) return false;
    if (sourceFilter && log.sourceTag !== sourceFilter) return false;
    if (projectFilter && log.projectName !== projectFilter) return false;
    if (stageFilter && log.pipelineStage !== stageFilter) return false;
    if (followupFilter) {
      if (!log.nextFollowup) return false;
      const followupDate = new Date(log.nextFollowup).toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
      if (followupFilter === "Due today" && followupDate !== today) return false;
      if (followupFilter === "Overdue" && followupDate >= today) return false;
    }
    const query = search.trim().toLowerCase();
    return !query || `${log.contactName} ${log.contactPhone} ${log.activityType} ${log.outcome} ${log.notes}`.toLowerCase().includes(query);
  });
  const calls = filtered.filter((log) => log.activityType === "Call").length;
  const newProspects = filtered.filter((log) => log.sourceTag === "LEAD").length;
  const visitBookings = filtered.filter((log) => log.activityType === "Site Visit").length;
  const followUps = filtered.filter((log) => log.status === "Follow-up").length;

  const statusStyle = (status: string) => {
    if (status === "Confirmed" || status === "Converted") return "bg-green-100 text-green-700";
    if (status === "Not Interested") return "bg-red-100 text-red-700";
    if (status === "New") return "bg-violet-100 text-violet-700";
    if (status === "Site Visit") return "bg-blue-100 text-blue-700";
    return "bg-amber-100 text-amber-700";
  };

  return (
    <div className="h-full overflow-auto pb-4">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-base font-bold text-slate-900">Daily Outreach Log</h2>
          <p className="text-xs text-gray-500 mt-0.5">Track daily calls, follow-ups, prospects and site visit bookings.</p>
        </div>
        <button onClick={openCreate} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-violet-600 hover:bg-violet-700">
          <Plus size={13} /> New Log Entry
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-3 mb-4">
        <input type="date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)}
          className="border rounded-xl px-3 py-2.5 text-sm bg-white" style={{ borderColor: "#e2e8f0" }} />
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by contact, phone, activity or outcome…"
            className="w-full border rounded-xl pl-9 pr-3 py-2.5 text-sm bg-white" style={{ borderColor: "#e2e8f0" }} />
        </div>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
          <option value="">All sources</option><option>EVENT</option><option>LEAD</option>
        </select>
        <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
          <option value="">All projects</option>{Array.from(new Set(logs.map((log) => log.projectName).filter(Boolean))).sort().map((project) => <option key={project}>{project}</option>)}
        </select>
        <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
          <option value="">All stages</option>{["Contacted", "Site Scheduled", "Converted", "Lost / Dead"].map((stage) => <option key={stage}>{stage}</option>)}
        </select>
        <select value={followupFilter} onChange={(e) => setFollowupFilter(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
          <option value="">All follow-ups</option><option>Due today</option><option>Overdue</option>
        </select>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        {[
          { label: "Total Calls Made", value: calls, color: "#10b981", icon: <PhoneCall size={17} /> },
          { label: "New Prospects", value: newProspects, color: "#3b82f6", icon: <Users size={17} /> },
          { label: "Site Visit Bookings", value: visitBookings, color: "#a855f7", icon: <Calendar size={17} /> },
          { label: "Follow-ups", value: followUps, color: "#f59e0b", icon: <ClipboardList size={17} /> },
        ].map((card) => (
          <div key={card.label} className="bg-white border rounded-xl p-4 flex items-center gap-3" style={{ borderColor: "#e2e8f0" }}>
            <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: `${card.color}18`, color: card.color }}>{card.icon}</div>
            <div>
              <p className="text-[10px] font-semibold text-gray-400">{card.label}</p>
              <p className="text-xl font-extrabold text-slate-900">{card.value}</p>
            </div>
          </div>
        ))}
      </div>

      {error && !modalOpen && <div className="mb-4 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800">{error}</div>}

      <div className="bg-white rounded-xl border overflow-hidden" style={{ borderColor: "#e2e8f0" }}>
        <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: "#e2e8f0" }}>
          <h3 className="text-sm font-bold text-slate-900">Today's Outreach Log</h3>
          <span className="text-xs text-gray-400">{filtered.length} entries</span>
        </div>
        {loading ? (
          <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-violet-500" /></div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center"><ClipboardList size={30} className="mx-auto mb-2 text-gray-300" /><p className="text-sm text-gray-400">No outreach logged for this date.</p></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="bg-slate-50">
                {["TIME", "ACTIVITY (+ SUB)", "CONTACT (+ SOURCE)", "PHONE", "PROJECT", "STAGE", "STATUS", "OUTCOME / NEXT STEP", "NEXT FOLLOW-UP", "ASSIGNED TO", "REPORTED BY", "ACTIONS"].map((heading) => (
                  <th key={heading} className="px-3 py-3 text-left text-[10px] font-bold tracking-wide text-gray-400 whitespace-nowrap">{heading}</th>
                ))}
              </tr></thead>
              <tbody>
                {filtered.map((log) => (
                  <tr key={log.id} className="border-t hover:bg-violet-50/30" style={{ borderColor: "#f1f5f9" }}>
                    <td className="px-3 py-3 text-slate-500 whitespace-nowrap">{new Date(log.occurredAt).toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" })}</td>
                    <td className="px-3 py-3 font-semibold text-violet-700 whitespace-nowrap"><div>{log.activityType}</div>{log.activitySubtype && <div className="text-[9px] font-normal text-gray-400">{log.activitySubtype}</div>}</td>
                    <td className="px-3 py-3 font-semibold text-slate-800 whitespace-nowrap"><div>{log.contactName}</div><span className="mt-1 inline-block rounded bg-blue-50 px-1.5 py-0.5 text-[8px] font-bold text-blue-700">{log.sourceTag}</span></td>
                    <td className="px-3 py-3 font-mono text-slate-500 whitespace-nowrap">{log.contactPhone}</td>
                    <td className="px-3 py-3 text-slate-500 min-w-36">{log.projectName || "General"}</td>
                    <td className="px-3 py-3 text-slate-500 whitespace-nowrap">{log.pipelineStage || "—"}</td>
                    <td className="px-3 py-3"><span className={`px-2 py-1 rounded-full text-[10px] font-bold whitespace-nowrap ${statusStyle(log.status)}`}>{log.status}</span></td>
                    <td className="px-3 py-3 text-slate-600 min-w-48">{log.outcome}</td>
                    <td className="px-3 py-3 text-slate-500 min-w-40">{log.nextFollowup ? <><div>{displayDateTime(log.nextFollowup)}</div><div className="text-[9px] text-amber-600">{log.followupType}</div></> : "—"}</td>
                    <td className="px-3 py-3 text-slate-500 whitespace-nowrap">{log.assignedToName || (log.assignedTo ? "Assigned user" : "—")}</td>
                    <td className="px-3 py-3 text-slate-500 whitespace-nowrap">{log.reportedBy}</td>
                    <td className="px-3 py-3"><button onClick={() => setDeleteId(log.id)} className="p-1.5 rounded hover:bg-red-50"><Trash2 size={13} className="text-red-500" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modalOpen && <OutreachEntryModal projects={projects} reporter={reporter} onClose={() => setModalOpen(false)} onSaved={(keepOpen) => { logActivity({ category: "other", action: "create", description: "Outreach log created", actor_name: reporter }); load(); if (!keepOpen) setModalOpen(false); }} />}

      {deleteId !== null && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-xs p-5">
            <h3 className="font-bold text-sm text-slate-900">Delete outreach entry?</h3>
            <p className="text-xs text-gray-500 mt-1 mb-4">This action cannot be undone.</p>
            <div className="flex gap-2">
              <button onClick={() => setDeleteId(null)} className="flex-1 py-2 rounded-lg border text-xs font-semibold text-gray-500">Cancel</button>
              <button onClick={() => remove(deleteId)} className="flex-1 py-2 rounded-lg text-xs font-bold text-white bg-red-600">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Analysis Section — real data from DB ────────────────────────────────────

function AnalysisSection() {
  const [leads,  setLeads]  = useState<Lead[]>([]);
  const [events, setEvents] = useState<LeadEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      supabase.from("lead_contacts").select("*").then(({ data }) =>
        (data ?? []).map((r: any) => ({
          id: r.id, firstName: r.first_name, lastName: r.last_name ?? "",
          phone: r.phone ?? "", email: r.email ?? "",
          eventId: Number(r.event_id ?? 0), note: r.note ?? "",
          status: (r.status ?? "contacts") as PipelineStatus,
        }))
      ).catch(() => [] as Lead[]),
      supabase.from("lead_events").select("*").order("date").then(({ data }) =>
        (data ?? []).map((r: any) => ({
          id: r.id, name: r.name, location: r.location, nature: r.nature,
          contacts: Number(r.contacts ?? 0), marketingPax: Number(r.marketing_pax ?? 0),
          budget: Number(r.budget ?? 0), date: r.date,
        }))
      ).catch(() => [] as LeadEvent[]),
    ]).then(([l, e]) => { setLeads(l); setEvents(e); setLoading(false); });
  }, []);

  const totalLeads     = leads.length;
  const converted      = leads.filter((l) => l.status === "converted").length;
  const siteScheduled  = leads.filter((l) => l.status === "site_scheduled").length;
  const totalBudget    = events.reduce((s, e) => s + e.budget, 0);
  const convRate       = totalLeads > 0 ? ((converted / totalLeads) * 100).toFixed(1) : "0.0";
  const cpl            = totalLeads > 0 && totalBudget > 0 ? Math.round(totalBudget / totalLeads) : 0;

  const pipelineData = PIPELINE_STAGES.map((s) => {
    const count = leads.filter((l) => l.status === s.id).length;
    const pct   = totalLeads > 0 ? Math.round((count / totalLeads) * 100) : 0;
    return { ...s, count, pct };
  });

  // Chart: last 6 events with contacts and lead count saved per event
  const recentEvents = events.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6).reverse();
  const chartData = recentEvents.map((ev) => ({
    name:      ev.name.length > 14 ? ev.name.slice(0, 13) + "…" : ev.name,
    attendees: ev.marketingPax,
    leads:     ev.contacts,
  }));

  // Performance table: per-event, count leads from lead_contacts
  const perfData = recentEvents.map((ev) => {
    const evLeads     = leads.filter((l) => l.eventId === ev.id);
    const evConverted = evLeads.filter((l) => l.status === "converted").length;
    const evSite      = evLeads.filter((l) => l.status === "site_scheduled" || l.status === "converted").length;
    const convPct     = evLeads.length > 0 ? ((evConverted / evLeads.length) * 100).toFixed(1) + "%" : "—";
    return {
      name:    ev.name,
      budget:  ev.budget,
      leads:   evLeads.length,
      tours:   evSite,
      conv:    evConverted,
      convPct,
    };
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <div className="w-6 h-6 rounded-full border-2 border-purple-300 border-t-purple-600 animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto pb-4">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h2 className="text-base font-bold" style={{ color: "#172033" }}>Leads & Event Analytics</h2>
          <p className="text-xs mt-0.5" style={{ color: "#64748b" }}>Live data — pipeline, event performance, conversion ratios</p>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        {[
          { label: "TOTAL LEADS",       value: `${totalLeads} Leads`,      sub: `${events.length} events`,       accent: "#7c3aed", icon: <Users size={18} color="#7c3aed" />, up: true },
          { label: "CONVERSION RATE",   value: `${convRate}%`,             sub: `${converted} converted`,        accent: "#0f9d8f", icon: <Target size={18} color="#0f9d8f" />, up: Number(convRate) >= 20 },
          { label: "COST PER LEAD",     value: cpl > 0 ? fmtKES(cpl) : "—", sub: `Budget: ${fmtKES(totalBudget)}`, accent: "#10b981", icon: <TrendingDown size={18} color="#10b981" />, up: false },
          { label: "SITE TOURS",        value: `${siteScheduled + converted}`, sub: `${siteScheduled} scheduled`,  accent: "#f97316", icon: <Activity size={18} color="#f97316" />, up: true },
        ].map(({ label, value, sub, accent, icon, up }) => (
          <div key={label} className="bg-white rounded-lg border overflow-hidden" style={{ borderColor: "#e2e8f0" }}>
            <div className="w-full h-1" style={{ background: accent }} />
            <div className="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold uppercase tracking-wide" style={{ color: "#94a3b8" }}>{label}</span>
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${accent}18` }}>{icon}</div>
              </div>
              <div className="text-xl font-bold mb-1" style={{ color: "#172033" }}>{value}</div>
              <div className="flex items-center gap-1 text-[11px] font-semibold" style={{ color: accent }}>
                {up ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                {sub}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Pipeline Breakdown + Chart */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
        <div className="bg-white rounded-lg border p-4" style={{ borderColor: "#e2e8f0" }}>
          <h3 className="text-sm font-bold mb-3" style={{ color: "#172033" }}>Lead Pipeline Breakdown</h3>
          {totalLeads === 0 ? (
            <p className="text-xs text-center py-4" style={{ color: "#94a3b8" }}>No leads yet — add contacts in the Leads tab</p>
          ) : (
            <div className="flex flex-col gap-3">
              {pipelineData.map(({ id, label, count, pct, color }) => (
                <div key={id}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] font-semibold" style={{ color: "#334155" }}>{label.replace(" (New)", "")}</span>
                    <span className="text-[11px] font-bold" style={{ color }}>{count} ({pct}%)</span>
                  </div>
                  <div className="h-2 rounded-full overflow-hidden" style={{ background: "#f1f5f9" }}>
                    <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white rounded-lg border p-4" style={{ borderColor: "#e2e8f0" }}>
          <h3 className="text-sm font-bold mb-3" style={{ color: "#172033" }}>Event Attendance vs Leads (Recent {recentEvents.length})</h3>
          {chartData.length === 0 ? (
            <div className="flex items-center justify-center h-40">
              <p className="text-xs" style={{ color: "#94a3b8" }}>No events yet</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <RechartBarChart data={chartData} barSize={18} barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 9, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ fontSize: 11, borderRadius: 6, border: "1px solid #e2e8f0" }} />
                <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
                <Bar key="bar-attendees" dataKey="attendees" name="Attendees"   fill="#7c3aed" radius={[3,3,0,0]} isAnimationActive={false} />
                <Bar key="bar-leads"     dataKey="leads"     name="Contacts"    fill="#f97316" radius={[3,3,0,0]} isAnimationActive={false} />
              </RechartBarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Performance Table */}
      <div className="bg-white rounded-lg border" style={{ borderColor: "#e2e8f0" }}>
        <div className="px-4 py-3 border-b" style={{ borderColor: "#e2e8f0" }}>
          <h3 className="text-sm font-bold" style={{ color: "#172033" }}>Performance by Event</h3>
        </div>
        {perfData.length === 0 ? (
          <div className="py-10 text-center">
            <BarChart2 size={28} className="mx-auto mb-2" color="#cbd5e1" />
            <p className="text-sm font-semibold" style={{ color: "#94a3b8" }}>No event data yet</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ background: "#f8fafc" }}>
                  {["EVENT","BUDGET","LEADS IN DB","SITE TOURS","CONVERSIONS","CONV. RATE"].map((h) => (
                    <th key={h} className="text-left px-4 py-2.5 font-semibold uppercase tracking-wide text-[10px] whitespace-nowrap" style={{ color: "#94a3b8" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {perfData.map((row) => (
                  <tr key={row.name} className="border-t hover:bg-gray-50 transition-colors" style={{ borderColor: "#f1f5f9" }}>
                    <td className="px-4 py-2.5 font-semibold" style={{ color: "#172033" }}>{row.name}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap" style={{ color: "#475569" }}>{fmtKESFull(row.budget)}</td>
                    <td className="px-4 py-2.5 font-medium" style={{ color: "#7c3aed" }}>{row.leads}</td>
                    <td className="px-4 py-2.5" style={{ color: "#475569" }}>{row.tours}</td>
                    <td className="px-4 py-2.5" style={{ color: "#475569" }}>{row.conv}</td>
                    <td className="px-4 py-2.5 font-bold" style={{ color: "#10b981" }}>{row.convPct}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Leads Page ───────────────────────────────────────────────────────────────

type LeadsTab = "events" | "leads" | "site-visits" | "outreach" | "analysis";

const LEADS_TABS: { id: LeadsTab; label: string; icon: React.ReactNode }[] = [
  { id: "events",   label: "EVENTS",   icon: <Calendar  size={15} /> },
  { id: "leads",    label: "LEADS",    icon: <Users     size={15} /> },
  { id: "site-visits", label: "SITE VISITS", icon: <MapPin size={15} /> },
  { id: "outreach", label: "DAILY OUTREACH LOG", icon: <ClipboardList size={15} /> },
  { id: "analysis", label: "ANALYSIS", icon: <BarChart2 size={15} /> },
];

export function LeadsPage() {
  const [activeTab, setActiveTab] = useState<LeadsTab>("events");

  return (
    <div className="flex flex-col md:flex-row h-full overflow-hidden">
      {/* Secondary sidebar — top bar on mobile, side column on md+ */}
      <div className="md:w-44 md:flex-shrink-0 flex flex-row md:flex-col border-b md:border-b-0 md:border-r md:py-4 overflow-x-auto"
        style={{ background: "#fff", borderColor: "#e2e8f0" }}>
        <div className="hidden md:block px-4 mb-4">
          <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "#94a3b8" }}>LEAD MODULE</p>
        </div>
        <nav className="flex flex-row md:flex-col gap-1 px-2 py-2 md:py-0 w-full">
          {LEADS_TABS.map(({ id, label, icon }) => {
            const isActive = activeTab === id;
            return (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors flex-shrink-0"
                style={{
                  background: isActive ? "#7c3aed" : "transparent",
                  color:      isActive ? "#fff"    : "#64748b",
                  minWidth:   "fit-content",
                }}
              >
                <span style={{ opacity: isActive ? 1 : 0.7 }}>{icon}</span>
                <span className="text-[11px] font-bold tracking-wide">{label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        <div className="flex-1 overflow-hidden p-4 md:p-5">
          {activeTab === "events"   && <EventsSection />}
          {activeTab === "leads"    && <LeadsSection />}
          {activeTab === "site-visits" && <SiteVisitsSection />}
          {activeTab === "outreach" && <DailyOutreachSection />}
          {activeTab === "analysis" && <AnalysisSection />}
        </div>
      </div>
    </div>
  );
}
