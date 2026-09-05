import React, { useState, useMemo } from "react";
import {
  Calendar, MapPin, Users, DollarSign, BarChart2,
  Plus, Search, Edit2, X, TrendingUp, TrendingDown,
  ChevronLeft, ChevronRight, Target, Activity,
} from "lucide-react";
import {
  BarChart as RechartBarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { fmtKES, fmtKESFull, fmtDate } from "@/app/shared";

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

// ─── Seed data ────────────────────────────────────────────────────────────────

const SEED_EVENTS: LeadEvent[] = [
  { id: 1, name: "Nairobi Plot Expo",       location: "KICC",           nature: "Exhibition / Sales",          contacts: 42, marketingPax: 150, budget: 180000, date: "2026-08-24" },
  { id: 2, name: "Mombasa Site Visit",      location: "Mtwapa",         nature: "Client Tour / Booking",       contacts: 18, marketingPax: 80,  budget: 120000, date: "2026-09-05" },
  { id: 3, name: "Kajiado Open Day",        location: "Kajiado Town",   nature: "Land Handover Ceremony",      contacts: 29, marketingPax: 120, budget: 95000,  date: "2026-09-18" },
  { id: 4, name: "Egemeo Sacco AGM",        location: "Laico Regency",  nature: "Member Sensitization",        contacts: 65, marketingPax: 250, budget: 350000, date: "2026-10-12" },
  { id: 5, name: "Ruiru Site Open",         location: "Ruiru",          nature: "Site Open Day",               contacts: 30, marketingPax: 100, budget: 80000,  date: "2026-08-28" },
  { id: 6, name: "Machakos Roadshow",       location: "Machakos Town",  nature: "Sales Roadshow",              contacts: 22, marketingPax: 90,  budget: 75000,  date: "2026-08-30" },
];

const SEED_LEADS: Lead[] = [
  { id: 1,  firstName: "Olivia",  lastName: "Auma",    phone: "+254744555015", email: "olivia.a@gmail.com",       eventId: 1, note: "Interested in 1/8 acre",        status: "contacts" },
  { id: 2,  firstName: "Mary",    lastName: "Wanjiku", phone: "+254722333013", email: "wanjiku.m@gmail.com",      eventId: 1, note: "Needs financing options",        status: "contacts" },
  { id: 3,  firstName: "Peter",   lastName: "Njau",    phone: "+254711222012", email: "peter.njau@gmail.com",     eventId: 5, note: "Wants corner plot",              status: "contacts" },
  { id: 4,  firstName: "James",   lastName: "Mwangi",  phone: "+254712345678", email: "j.mwangi@yahoo.com",       eventId: 1, note: "Requested site visit map",       status: "contacted" },
  { id: 5,  firstName: "Mercy",   lastName: "Chebet",  phone: "+254724356789", email: "mercy.c@gmail.com",        eventId: 6, note: "Called twice, interested",       status: "contacted" },
  { id: 6,  firstName: "Denis",   lastName: "Kiprop",  phone: "+254734567890", email: "kiprop.d@outlook.com",     eventId: 5, note: "Scheduled for Saturday Tour",    status: "site_scheduled" },
  { id: 7,  firstName: "Anne",    lastName: "Waithera",phone: "+254745678901", email: "anne.w@gmail.com",         eventId: 6, note: "Tour on 15 Sep",                 status: "site_scheduled" },
  { id: 8,  firstName: "John",    lastName: "Kamau",   phone: "+254756789012", email: "kamau.j@egemeo.co.ke",     eventId: 6, note: "Paid booking deposit Ksh 50k",   status: "converted" },
  { id: 9,  firstName: "Lydia",   lastName: "Atieno",  phone: "+254767890123", email: "lydia.a@gmail.com",        eventId: 1, note: "Full payment in progress",        status: "converted" },
  { id: 10, firstName: "Sarah",   lastName: "Wambui",  phone: "+254778901234", email: "s.wambui@gmail.com",       eventId: 2, note: "Unreachable after 3 attempts",   status: "lost" },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DAY_LABELS  = ["S","M","T","W","T","F","S"];

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}
function getFirstDayOfWeek(year: number, month: number) {
  return new Date(year, month, 1).getDay();
}

// ─── Mini Calendar Cell ───────────────────────────────────────────────────────

function MonthCalendar({ year, month, eventDates }: { year: number; month: number; eventDates: Set<string> }) {
  const days    = getDaysInMonth(year, month);
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
          const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const hasEvent = eventDates.has(iso);
          return (
            <div
              key={i}
              className="flex items-center justify-center rounded"
              style={{
                height: 16,
                fontSize: 9,
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
  const [calYear,   setCalYear]   = useState(new Date().getFullYear());
  const [events,    setEvents]    = useState<LeadEvent[]>(SEED_EVENTS);
  const [editing,   setEditing]   = useState<LeadEvent | null>(null);
  const [formData,  setFormData]  = useState<Omit<LeadEvent, "id">>(EMPTY_EVENT);
  const [panelOpen, setPanelOpen] = useState(false);

  const eventDates = useMemo(() => new Set(events.map((e) => e.date)), [events]);

  const openCreate = () => {
    setEditing(null);
    setFormData(EMPTY_EVENT);
    setPanelOpen(true);
  };
  const openEdit = (ev: LeadEvent) => {
    setEditing(ev);
    setFormData({ name: ev.name, location: ev.location, nature: ev.nature, contacts: ev.contacts, marketingPax: ev.marketingPax, budget: ev.budget, date: ev.date });
    setPanelOpen(true);
  };
  const handleSave = () => {
    if (!formData.name.trim() || !formData.date) return;
    if (editing) {
      setEvents((prev) => prev.map((e) => e.id === editing.id ? { ...editing, ...formData } : e));
    } else {
      const nextId = Math.max(0, ...events.map((e) => e.id)) + 1;
      setEvents((prev) => [...prev, { id: nextId, ...formData }]);
    }
    setPanelOpen(false);
  };
  const handleClear = () => { setFormData(EMPTY_EVENT); setEditing(null); };

  const totals = useMemo(() => ({
    events:    events.length,
    locations: new Set(events.map((e) => e.location)).size,
    contacts:  events.reduce((s, e) => s + e.contacts, 0),
    budget:    events.reduce((s, e) => s + e.budget, 0),
    avgPax:    events.length ? Math.round(events.reduce((s, e) => s + e.marketingPax, 0) / events.length) : 0,
  }), [events]);

  const field = (key: keyof typeof formData) => (
    <input
      className="w-full text-xs border rounded px-2.5 py-1.5 focus:outline-none focus:ring-1"
      style={{ borderColor: "#e2e8f0", color: "#172033", focusRingColor: "#7c3aed" }}
      value={String(formData[key] ?? "")}
      type={typeof formData[key] === "number" ? "number" : key === "date" ? "date" : "text"}
      onChange={(e) => setFormData((p) => ({ ...p, [key]: typeof formData[key] === "number" ? Number(e.target.value) : e.target.value }))}
    />
  );

  return (
    <div className="flex gap-4 h-full overflow-hidden">
      {/* Main */}
      <div className="flex-1 overflow-auto pb-4 pr-1">
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
            <Plus size={13} />
            New Event
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

        {/* 12-month calendar */}
        <div className="grid grid-cols-4 gap-3 mb-5">
          {Array.from({ length: 12 }, (_, m) => (
            <MonthCalendar key={m} year={calYear} month={m} eventDates={eventDates} />
          ))}
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-5 gap-3 mb-5">
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
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ background: "#f8fafc" }}>
                  {["NAME","LOCATION","NATURE OF THE EVENT","NO. CONTACTS","BUDGET","DATE","ACTION"].map((h) => (
                    <th key={h} className="text-left px-4 py-2.5 font-semibold uppercase tracking-wide text-[10px]" style={{ color: "#94a3b8" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {events.sort((a, b) => a.date.localeCompare(b.date)).map((ev, i) => (
                  <tr key={ev.id} className="border-t hover:bg-gray-50 transition-colors" style={{ borderColor: "#f1f5f9" }}>
                    <td className="px-4 py-2.5 font-semibold" style={{ color: "#172033" }}>{ev.name}</td>
                    <td className="px-4 py-2.5" style={{ color: "#475569" }}>{ev.location}</td>
                    <td className="px-4 py-2.5" style={{ color: "#475569" }}>{ev.nature}</td>
                    <td className="px-4 py-2.5 font-medium" style={{ color: "#7c3aed" }}>{ev.contacts} Leads</td>
                    <td className="px-4 py-2.5 font-medium" style={{ color: "#172033" }}>{fmtKESFull(ev.budget)}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap" style={{ color: "#64748b" }}>{fmtDate(ev.date)}</td>
                    <td className="px-4 py-2.5">
                      <button
                        onClick={() => openEdit(ev)}
                        className="flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded border transition-colors hover:bg-purple-50"
                        style={{ color: "#7c3aed", borderColor: "#c4b5fd" }}
                      >
                        <Edit2 size={11} /> Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Create/Edit Panel */}
      <div
        className="w-72 flex-shrink-0 bg-white border rounded-lg overflow-hidden flex flex-col"
        style={{ borderColor: "#e2e8f0", display: panelOpen ? "flex" : "none" }}
      >
        <div className="px-4 py-3 flex items-center justify-between flex-shrink-0" style={{ background: "#7c3aed" }}>
          <span className="text-xs font-bold text-white uppercase tracking-wide">{editing ? "EDIT EVENT" : "CREATE EVENT"}</span>
          <button onClick={() => setPanelOpen(false)}><X size={14} color="#fff" /></button>
        </div>
        <div className="flex-1 overflow-auto p-4 flex flex-col gap-3">
          {(
            [
              { key: "name",         label: "EVENT NAME",       placeholder: "e.g. Nairobi Plot Expo" },
              { key: "location",     label: "LOCATION",         placeholder: "e.g. KICC, Nairobi" },
              { key: "nature",       label: "NATURE OF EVENT",  placeholder: "e.g. Roadshow, Exhibition" },
              { key: "contacts",     label: "NO. OF CONTACTS",  placeholder: "Target contacts" },
              { key: "marketingPax", label: "MARKETING PAX",    placeholder: "Target attendees" },
              { key: "budget",       label: "BUDGET (Ksh)",     placeholder: "Estimated cost" },
              { key: "date",         label: "EVENT DATE",       placeholder: "YYYY-MM-DD" },
            ] as { key: keyof typeof formData; label: string; placeholder: string }[]
          ).map(({ key, label, placeholder }) => (
            <div key={key}>
              <label className="block text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: "#64748b" }}>{label}</label>
              <input
                className="w-full text-xs border rounded-lg px-2.5 py-2 focus:outline-none focus:ring-1 focus:ring-purple-400"
                style={{ borderColor: "#e2e8f0", color: "#172033" }}
                placeholder={placeholder}
                value={String(formData[key] ?? "")}
                type={typeof formData[key] === "number" ? "number" : key === "date" ? "date" : "text"}
                onChange={(e) => setFormData((p) => ({ ...p, [key]: typeof formData[key] === "number" ? Number(e.target.value) : e.target.value }))}
              />
            </div>
          ))}
        </div>
        <div className="p-4 flex gap-2 flex-shrink-0 border-t" style={{ borderColor: "#e2e8f0" }}>
          <button
            onClick={handleSave}
            className="flex-1 flex items-center justify-center gap-1.5 text-xs font-bold py-2.5 rounded-lg text-white transition-colors hover:opacity-90"
            style={{ background: "#0f9d8f" }}
          >
            <Plus size={12} /> Save Event
          </button>
          <button
            onClick={handleClear}
            className="px-4 text-xs font-semibold py-2.5 rounded-lg border transition-colors hover:bg-gray-50"
            style={{ color: "#64748b", borderColor: "#e2e8f0" }}
          >
            Clear
          </button>
        </div>
      </div>

      {/* Open panel toggle when closed */}
      {!panelOpen && (
        <button
          onClick={openCreate}
          className="w-10 flex-shrink-0 bg-white border rounded-lg flex flex-col items-center justify-center gap-2 hover:bg-purple-50 transition-colors"
          style={{ borderColor: "#e2e8f0" }}
          title="Create Event"
        >
          <Plus size={16} color="#7c3aed" />
          <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: "#7c3aed", writingMode: "vertical-rl" }}>New Event</span>
        </button>
      )}
    </div>
  );
}

// ─── Leads Section ────────────────────────────────────────────────────────────

const YEARS_FILTER = [2021, 2022, 2023, 2024, 2025, 2026];
const MONTHS_SHORT = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

function LeadsSection() {
  const today     = new Date();
  const [selYear, setSelYear] = useState(today.getFullYear());
  const [selMonth,setSelMonth]= useState(today.getMonth());
  const [leads,   setLeads]   = useState<Lead[]>(SEED_LEADS);
  const [events]              = useState<LeadEvent[]>(SEED_EVENTS);
  const [search,  setSearch]  = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [newLead, setNewLead] = useState<Omit<Lead, "id">>({ firstName: "", lastName: "", phone: "", email: "", eventId: 0, note: "", status: "contacts" });

  const monthEvents = useMemo(() =>
    events.filter((e) => {
      const d = new Date(e.date);
      return d.getFullYear() === selYear && d.getMonth() === selMonth;
    }),
  [events, selYear, selMonth]);

  const filteredLeads = useMemo(() =>
    leads.filter((l) => {
      const q = search.toLowerCase();
      return !q || `${l.firstName} ${l.lastName} ${l.phone} ${l.email}`.toLowerCase().includes(q);
    }),
  [leads, search]);

  const addLead = () => {
    if (!newLead.firstName.trim() || !newLead.phone.trim()) return;
    const nextId = Math.max(0, ...leads.map((l) => l.id)) + 1;
    setLeads((prev) => [...prev, { id: nextId, ...newLead }]);
    setAddOpen(false);
    setNewLead({ firstName: "", lastName: "", phone: "", email: "", eventId: 0, note: "", status: "contacts" });
  };

  const changeStatus = (leadId: number, status: PipelineStatus) => {
    setLeads((prev) => prev.map((l) => l.id === leadId ? { ...l, status } : l));
  };

  const getEventName = (id: number) => events.find((e) => e.id === id)?.name ?? "—";

  return (
    <div className="h-full overflow-auto pb-4">
      {/* Title */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-bold" style={{ color: "#172033" }}>Leads Tracker & Pipeline</h2>
          <p className="text-xs mt-0.5" style={{ color: "#64748b" }}>Manage and track your sales leads</p>
        </div>
      </div>

      {/* Year Filter */}
      <div className="flex items-center gap-1.5 mb-3">
        {YEARS_FILTER.map((y) => (
          <button
            key={y}
            onClick={() => setSelYear(y)}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors"
            style={{
              background:   selYear === y ? "#7c3aed" : "white",
              color:        selYear === y ? "#fff"    : "#64748b",
              borderColor:  selYear === y ? "#7c3aed" : "#e2e8f0",
            }}
          >{y}</button>
        ))}
      </div>

      {/* Month Filter */}
      <div className="flex items-center gap-1 flex-wrap mb-4">
        {MONTHS_SHORT.map((m, i) => (
          <button
            key={m}
            onClick={() => setSelMonth(i)}
            className="text-[11px] font-bold px-2.5 py-1 rounded border transition-colors"
            style={{
              background:  selMonth === i ? "#f97316" : "white",
              color:       selMonth === i ? "#fff"    : "#64748b",
              borderColor: selMonth === i ? "#f97316" : "#e2e8f0",
            }}
          >{m}</button>
        ))}
      </div>

      {/* Event Filter */}
      {monthEvents.length > 0 && (
        <div className="bg-white rounded-lg border p-3 mb-4" style={{ borderColor: "#e2e8f0" }}>
          <p className="text-[11px] font-bold uppercase tracking-wide mb-2" style={{ color: "#64748b" }}>
            Events in {MONTHS_SHORT[selMonth]} {selYear}:
          </p>
          <div className="flex flex-wrap gap-2">
            {monthEvents.map((ev, i) => (
              <span key={ev.id} className="text-xs px-2.5 py-1 rounded-full font-medium" style={{ background: "#f1f5f9", color: "#334155" }}>
                Event {i + 1}: {ev.name} ({new Date(ev.date).getDate()} {MONTHS_SHORT[new Date(ev.date).getMonth()]})
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Pipeline */}
      <div className="mb-4">
        <h3 className="text-sm font-bold mb-3" style={{ color: "#172033" }}>Pipeline View (Sales Funnel)</h3>
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
          {PIPELINE_STAGES.map(({ id, label, color, bg }) => {
            const stageLeads = leads.filter((l) => l.status === id);
            return (
              <div key={id} className="rounded-lg border overflow-hidden" style={{ borderColor: "#e2e8f0" }}>
                <div className="px-3 py-2" style={{ background: bg, borderBottom: `2px solid ${color}` }}>
                  <span className="text-[10px] font-bold uppercase tracking-wide" style={{ color }}>{label}</span>
                  <span className="ml-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full text-white" style={{ background: color }}>{stageLeads.length}</span>
                </div>
                <div className="p-2 flex flex-col gap-1.5 min-h-[120px] bg-white">
                  {stageLeads.map((lead) => (
                    <div key={lead.id} className="rounded border p-2" style={{ borderColor: "#e2e8f0" }}>
                      <div className="text-[11px] font-semibold" style={{ color: "#172033" }}>{lead.firstName} {lead.lastName}</div>
                      <div className="text-[10px] mt-0.5" style={{ color: "#94a3b8" }}>{lead.phone}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Search + Add */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex-1 relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2" color="#94a3b8" />
          <input
            className="w-full text-xs border rounded-lg pl-8 pr-3 py-2 focus:outline-none focus:ring-1 focus:ring-purple-400"
            style={{ borderColor: "#e2e8f0", color: "#172033" }}
            placeholder="Search name, phone, email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button
          onClick={() => setAddOpen(true)}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg text-white transition-colors hover:opacity-90"
          style={{ background: "#7c3aed" }}
        >
          <Plus size={13} /> Add Lead
        </button>
        <div className="text-[11px] px-3 py-2 rounded-lg" style={{ background: "#f8fafc", color: "#64748b", border: "1px solid #e2e8f0" }}>
          Fields: First, Last, Phone, Email, Event, Note
        </div>
      </div>

      {/* Add Lead Modal */}
      {addOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold" style={{ color: "#172033" }}>Add New Lead</h3>
              <button onClick={() => setAddOpen(false)}><X size={15} color="#94a3b8" /></button>
            </div>
            <div className="flex flex-col gap-3">
              {[
                { key: "firstName", label: "First Name", placeholder: "e.g. Olivia" },
                { key: "lastName",  label: "Last Name",  placeholder: "e.g. Auma" },
                { key: "phone",     label: "Phone",      placeholder: "+254..." },
                { key: "email",     label: "Email",      placeholder: "email@example.com" },
                { key: "note",      label: "Note",       placeholder: "Any note..." },
              ].map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label className="block text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: "#64748b" }}>{label}</label>
                  <input
                    className="w-full text-xs border rounded-lg px-2.5 py-2 focus:outline-none focus:ring-1 focus:ring-purple-400"
                    style={{ borderColor: "#e2e8f0" }}
                    placeholder={placeholder}
                    value={String(newLead[key as keyof typeof newLead] ?? "")}
                    onChange={(e) => setNewLead((p) => ({ ...p, [key]: e.target.value }))}
                  />
                </div>
              ))}
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
            </div>
            <div className="flex gap-2 mt-4">
              <button
                onClick={addLead}
                className="flex-1 text-xs font-bold py-2.5 rounded-lg text-white"
                style={{ background: "#7c3aed" }}
              >Save Lead</button>
              <button
                onClick={() => setAddOpen(false)}
                className="px-4 text-xs font-semibold py-2.5 rounded-lg border"
                style={{ color: "#64748b", borderColor: "#e2e8f0" }}
              >Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Leads Output Ledger */}
      <div className="bg-white rounded-lg border" style={{ borderColor: "#e2e8f0" }}>
        <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: "#e2e8f0" }}>
          <h3 className="text-sm font-bold" style={{ color: "#172033" }}>Leads Output Ledger</h3>
          <span className="text-xs" style={{ color: "#94a3b8" }}>{filteredLeads.length} leads</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr style={{ background: "#f8fafc" }}>
                {["FIRST NAME","LAST NAME","MOBILE / PHONE","EMAIL ADDRESS","SOURCE EVENT","NOTE / SECTION","PIPELINE STATUS"].map((h) => (
                  <th key={h} className="text-left px-4 py-2.5 font-semibold uppercase tracking-wide text-[10px] whitespace-nowrap" style={{ color: "#94a3b8" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredLeads.map((lead) => {
                const badge = STATUS_BADGE[lead.status];
                return (
                  <tr key={lead.id} className="border-t hover:bg-gray-50 transition-colors" style={{ borderColor: "#f1f5f9" }}>
                    <td className="px-4 py-2.5 font-semibold" style={{ color: "#172033" }}>{lead.firstName}</td>
                    <td className="px-4 py-2.5 font-semibold" style={{ color: "#172033" }}>{lead.lastName}</td>
                    <td className="px-4 py-2.5 font-mono" style={{ color: "#475569" }}>{lead.phone}</td>
                    <td className="px-4 py-2.5" style={{ color: "#475569" }}>{lead.email}</td>
                    <td className="px-4 py-2.5" style={{ color: "#475569" }}>{getEventName(lead.eventId)}</td>
                    <td className="px-4 py-2.5 max-w-[180px]" style={{ color: "#64748b" }}>{lead.note}</td>
                    <td className="px-4 py-2.5">
                      <select
                        className="text-[11px] font-semibold border rounded px-2 py-0.5 focus:outline-none"
                        style={{ color: badge.color, borderColor: badge.border, background: "white" }}
                        value={lead.status}
                        onChange={(e) => changeStatus(lead.id, e.target.value as PipelineStatus)}
                      >
                        {PIPELINE_STAGES.map((s) => (
                          <option key={s.id} value={s.id}>{s.label.replace(" (New)", "")}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Analysis Section ─────────────────────────────────────────────────────────

const PIPELINE_DATA = [
  { id: "contacts",       label: "CONTACTS (New)",  count: 65, pct: 35, color: "#64748b" },
  { id: "contacted",      label: "CONTACTED",        count: 48, pct: 26, color: "#f97316" },
  { id: "site_scheduled", label: "SITE SCHEDULED",   count: 32, pct: 17, color: "#3b82f6" },
  { id: "converted",      label: "CONVERTED",        count: 22, pct: 11, color: "#0f9d8f" },
  { id: "lost",           label: "LOST / DEAD",      count: 17, pct:  9, color: "#ef4444" },
];

const CHART_DATA = [
  { name: "Plot Expo",  attendees: 150, leads: 42 },
  { name: "Site Visit", attendees:  80, leads: 18 },
  { name: "Open Day",   attendees: 120, leads: 29 },
  { name: "Sacco AGM",  attendees: 250, leads: 65 },
];

const PERF_DATA = [
  { channel: "Nairobi Plot Expo (KICC)",      cost: 180000, leads: 42, tours: 15, conv: 5, convPct: "11.9%", roi: "245%" },
  { channel: "Mombasa Client Site Visit",     cost: 120000, leads: 18, tours: 12, conv: 4, convPct: "22.2%", roi: "310%" },
  { channel: "Kajiado Open Day Tour",         cost:  95000, leads: 29, tours:  9, conv: 2, convPct: "6.9%",  roi: "180%" },
  { channel: "Sacco AGM Open House",          cost: 350000, leads: 65, tours: 32, conv: 11, convPct: "16.9%", roi: "420%" },
];

function AnalysisSection() {
  return (
    <div className="h-full overflow-auto pb-4">
      {/* Title */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-bold" style={{ color: "#172033" }}>Leads & Event Analytics Dashboard</h2>
          <p className="text-xs mt-0.5" style={{ color: "#64748b" }}>Visual tracking of lead acquisition, event performance, and conversion ratios.</p>
        </div>
        <div className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border" style={{ color: "#64748b", borderColor: "#e2e8f0" }}>
          <Calendar size={12} />
          Range: Last 90 Days
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        {[
          {
            label:    "TOTAL LEADS ACQUIRED",
            value:    "184 Leads",
            sub:      "+15% MoM",
            accent:   "#7c3aed",
            subColor: "#10b981",
            icon:     <Users size={20} color="#7c3aed" />,
            up: true,
          },
          {
            label:    "EVENT CONVERSION %",
            value:    "34.2%",
            sub:      "Target 30%",
            accent:   "#0f9d8f",
            subColor: "#0f9d8f",
            icon:     <Target size={20} color="#0f9d8f" />,
            up: true,
          },
          {
            label:    "COST PER LEAD (CPL)",
            value:    "Ksh 4,076",
            sub:      "-8% cost reduction",
            accent:   "#10b981",
            subColor: "#10b981",
            icon:     <TrendingDown size={20} color="#10b981" />,
            up: false,
          },
          {
            label:    "EST. CONVERTED SALES",
            value:    "Ksh 12.4M",
            sub:      "From 22 closed deals",
            accent:   "#f97316",
            subColor: "#f97316",
            icon:     <Activity size={20} color="#f97316" />,
            up: true,
          },
        ].map(({ label, value, sub, accent, subColor, icon, up }) => (
          <div key={label} className="bg-white rounded-lg border overflow-hidden" style={{ borderColor: "#e2e8f0" }}>
            <div className="w-full h-1" style={{ background: accent }} />
            <div className="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold uppercase tracking-wide" style={{ color: "#94a3b8" }}>{label}</span>
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${accent}15` }}>{icon}</div>
              </div>
              <div className="text-xl font-bold mb-1" style={{ color: "#172033" }}>{value}</div>
              <div className="flex items-center gap-1 text-[11px] font-semibold" style={{ color: subColor }}>
                {up ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                {sub}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Pipeline Breakdown + Chart row */}
      <div className="grid grid-cols-2 gap-4 mb-5">
        {/* Pipeline Breakdown */}
        <div className="bg-white rounded-lg border p-4" style={{ borderColor: "#e2e8f0" }}>
          <h3 className="text-sm font-bold mb-3" style={{ color: "#172033" }}>Lead Pipeline Breakdown (Current Status)</h3>
          <div className="flex flex-col gap-3">
            {PIPELINE_DATA.map(({ label, count, pct, color }) => (
              <div key={label}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] font-semibold" style={{ color: "#334155" }}>{label}</span>
                  <span className="text-[11px] font-bold" style={{ color }}>{count} ({pct}%)</span>
                </div>
                <div className="h-2 rounded-full overflow-hidden" style={{ background: "#f1f5f9" }}>
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Bar Chart */}
        <div className="bg-white rounded-lg border p-4" style={{ borderColor: "#e2e8f0" }}>
          <h3 className="text-sm font-bold mb-3" style={{ color: "#172033" }}>Event Success & Lead Yield (Recent 4 Events)</h3>
          <ResponsiveContainer width="100%" height={200}>
            <RechartBarChart data={CHART_DATA} barSize={18} barGap={4}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ fontSize: 11, borderRadius: 6, border: "1px solid #e2e8f0" }} />
              <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="attendees" name="Attendees"   fill="#7c3aed" radius={[3,3,0,0]} />
              <Bar dataKey="leads"     name="Leads Saved" fill="#f97316" radius={[3,3,0,0]} />
            </RechartBarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Performance Table */}
      <div className="bg-white rounded-lg border" style={{ borderColor: "#e2e8f0" }}>
        <div className="px-4 py-3 border-b" style={{ borderColor: "#e2e8f0" }}>
          <h3 className="text-sm font-bold" style={{ color: "#172033" }}>Performance Analysis by Marketing Channels</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr style={{ background: "#f8fafc" }}>
                {["CHANNEL / EVENT","ACQUISITION COST (Ksh)","TOTAL LEADS","SITE TOURS BOOKED","CONVERSIONS","ACQUISITION RATE","ROI %"].map((h) => (
                  <th key={h} className="text-left px-4 py-2.5 font-semibold uppercase tracking-wide text-[10px] whitespace-nowrap" style={{ color: "#94a3b8" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERF_DATA.map((row) => (
                <tr key={row.channel} className="border-t hover:bg-gray-50 transition-colors" style={{ borderColor: "#f1f5f9" }}>
                  <td className="px-4 py-2.5 font-semibold" style={{ color: "#172033" }}>{row.channel}</td>
                  <td className="px-4 py-2.5" style={{ color: "#475569" }}>{fmtKESFull(row.cost)}</td>
                  <td className="px-4 py-2.5 font-medium" style={{ color: "#7c3aed" }}>{row.leads} Leads</td>
                  <td className="px-4 py-2.5" style={{ color: "#475569" }}>{row.tours} Sites Scheduled</td>
                  <td className="px-4 py-2.5" style={{ color: "#475569" }}>{row.conv} Booked Plots</td>
                  <td className="px-4 py-2.5 font-medium" style={{ color: "#3b82f6" }}>{row.convPct} Conv.</td>
                  <td className="px-4 py-2.5 font-bold" style={{ color: "#10b981" }}>{row.roi}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Leads Page (main export) ─────────────────────────────────────────────────

type LeadsTab = "events" | "leads" | "analysis";

const LEADS_TABS: { id: LeadsTab; label: string; icon: React.ReactNode }[] = [
  { id: "events",   label: "EVENTS",   icon: <Calendar size={15} /> },
  { id: "leads",    label: "LEADS",    icon: <Users    size={15} /> },
  { id: "analysis", label: "ANALYSIS", icon: <BarChart2 size={15} /> },
];

export function LeadsPage() {
  const [activeTab, setActiveTab] = useState<LeadsTab>("events");

  return (
    <div className="flex h-full overflow-hidden">
      {/* Leads Module Secondary Sidebar */}
      <div
        className="w-44 flex-shrink-0 flex flex-col border-r py-4"
        style={{ background: "#fff", borderColor: "#e2e8f0" }}
      >
        <div className="px-4 mb-4">
          <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "#94a3b8" }}>LEAD MODULE</p>
        </div>
        <nav className="flex flex-col gap-1 px-2">
          {LEADS_TABS.map(({ id, label, icon }) => {
            const isActive = activeTab === id;
            return (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left transition-colors w-full"
                style={{
                  background: isActive ? "#7c3aed" : "transparent",
                  color:      isActive ? "#fff"    : "#64748b",
                }}
              >
                <span style={{ opacity: isActive ? 1 : 0.7 }}>{icon}</span>
                <span className="text-[11px] font-bold tracking-wide">{label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Main content area */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-hidden p-5">
          {activeTab === "events"   && <EventsSection />}
          {activeTab === "leads"    && <LeadsSection />}
          {activeTab === "analysis" && <AnalysisSection />}
        </div>
      </div>
    </div>
  );
}
