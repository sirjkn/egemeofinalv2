import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowRight, Building2, Calendar, Check, ChevronDown, Clock, Globe2,
  Mail, MapPin, MessageCircle, Phone, RefreshCw, Search, Star, User,
  UserPlus, Users, WalletCards, X,
} from "lucide-react";
import { supabase } from "@/lib/supabase";

type ProjectOption = { id: number; name: string; location: string };
type ContactOption = {
  key: string;
  id: number;
  name: string;
  phone: string;
  email?: string;
  source: "LEAD" | "EVENT" | "CLIENT" | "MEMBER";
  sourceLabel: string;
  eventId?: number;
  leadId?: number;
};
type UserOption = { id: string; label: string };

type Props = {
  projects: ProjectOption[];
  reporter: string;
  onClose: () => void;
  onSaved: (keepOpen?: boolean) => void;
};

const ACTIVITY = [
  { id: "Call", icon: Phone },
  { id: "Office Visit", icon: Building2 },
  { id: "Online Enquiry", icon: Globe2 },
  { id: "Customer Referral", icon: Users },
  { id: "Site Visit", icon: MapPin },
  { id: "Follow-up", icon: RefreshCw },
  { id: "Event Lead", icon: Star },
  { id: "Payment", icon: WalletCards },
  { id: "Logistics", icon: Building2 },
];
const STATUS = ["Follow-up", "Site Visit", "Confirmed", "Converted", "Not Interested"];
const STAGES = ["Contacted", "Site Scheduled", "Converted", "Lost / Dead"];
const SOURCE_COLORS: Record<string, string> = {
  EVENT: "bg-orange-50 text-orange-700 border-orange-200",
  LEAD: "bg-blue-50 text-blue-700 border-blue-200",
  CLIENT: "bg-emerald-50 text-emerald-700 border-emerald-200",
  MEMBER: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

function localDate() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function localTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function tomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

const initialForm = () => ({
  date: "", time: "", activity: "", purpose: "",
  direction: "", result: "", onlineChannel: "", adReference: "",
  visitStage: "", followupOn: "", paymentType: "", amount: "",
  contactMode: "existing" as "existing" | "new", contactKey: "", contactType: "",
  fullName: "", phone: "", altPhone: "", email: "", area: "", leadSource: "",
  eventId: 0, referrer: "", projectId: 0, plotReference: "", budgetRange: "",
  paymentPreference: "", stage: "", status: "",
  outcome: "", lostReason: "", otherLostReason: "", notes: "",
  visitDate: "", visitTime: "", visitors: "", transport: "",
  pickupPoint: "", visitOutcome: "",
  followupDate: "", followupTime: "", followupType: "",
  followupOther: "", anotherProjectId: 0, assignedTo: "", priority: "",
  remindVia: [] as string[], whatsappMessage: "", reportedBy: "", signedBy: "",
});

function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return <label className="mb-1.5 block text-[11px] font-bold text-slate-600">{children}{required && <span className="text-red-500"> *</span>}</label>;
}
const fieldClass = "h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-800 outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-100";

function ChipGroup({ options, value, onChange, tone = "violet" }: {
  options: string[]; value: string; onChange: (value: string) => void; tone?: "violet" | "amber";
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const selected = option === value;
        return (
          <button key={option} type="button" onClick={() => onChange(option)}
            className={`rounded-full border px-3 py-1.5 text-[11px] font-semibold transition ${
              selected
                ? tone === "amber" ? "border-amber-500 bg-amber-500 text-white" : "border-violet-600 bg-violet-600 text-white"
                : "border-slate-200 bg-white text-slate-600 hover:border-violet-300"
            }`}>
            {option}
          </button>
        );
      })}
    </div>
  );
}

function SectionTitle({ number, title, note, color = "violet" }: { number: number; title: string; note?: string; color?: "violet" | "amber" }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="flex items-center gap-2">
        <span className={`flex h-5 w-5 items-center justify-center rounded text-[10px] font-extrabold text-white ${color === "amber" ? "bg-amber-500" : "bg-violet-600"}`}>{number}</span>
        <h4 className="text-sm font-extrabold text-slate-900">{title}</h4>
      </div>
      {note && <span className="text-[9px] font-semibold text-slate-400">{note}</span>}
    </div>
  );
}

export function OutreachEntryModal({ projects, reporter, onClose, onSaved }: Props) {
  const [form, setForm] = useState(initialForm);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [events, setEvents] = useState<{ id: number; name: string; date: string }[]>([]);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = (key: string, value: any) => setForm((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    set("reportedBy", reporter);
    set("signedBy", reporter);
    Promise.all([
      supabase.from("lead_contacts").select("id,first_name,last_name,phone,email,event_id"),
      supabase.from("clients").select("id,name,phone,email"),
      supabase.from("shareholders").select("id,name,phone,email"),
      supabase.from("lead_events").select("id,name,date").order("date", { ascending: false }),
      supabase.from("user_profiles").select("id,full_name,role").order("full_name"),
    ]).then(([leadRows, clientRows, memberRows, eventRows, userRows]) => {
      const evs = (eventRows.data ?? []) as any[];
      setEvents(evs);
      const eventName = (id: number) => evs.find((event) => event.id === id);
      const next: ContactOption[] = [
        ...(leadRows.data ?? []).map((row: any) => {
          const event = eventName(row.event_id);
          return {
            key: `lead-${row.id}`, id: row.id, leadId: row.id,
            name: `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim(),
            phone: row.phone ?? "", email: row.email ?? "", eventId: row.event_id ?? undefined,
            source: event ? "EVENT" as const : "LEAD" as const,
            sourceLabel: event ? `${event.name} · ${event.date}` : "Lead database",
          };
        }),
        ...(clientRows.data ?? []).map((row: any) => ({
          key: `client-${row.id}`, id: row.id, name: row.name, phone: row.phone ?? "", email: row.email ?? "",
          source: "CLIENT" as const, sourceLabel: "Client",
        })),
        ...(memberRows.data ?? []).map((row: any) => ({
          key: `member-${row.id}`, id: row.id, name: row.name, phone: row.phone ?? "", email: row.email ?? "",
          source: "MEMBER" as const, sourceLabel: "Member / Shareholder",
        })),
      ];
      setContacts(next.filter((contact) => contact.name));
      const nextUsers = (userRows.data ?? []).map((row: any) => ({
        id: row.id, label: `${row.full_name || "System User"} (${String(row.role || "User").replace(/^./, (c) => c.toUpperCase())})`,
      }));
      setUsers(nextUsers);
      const defaultUser = nextUsers.find((user) => reporter.startsWith(user.label.split(" (")[0]));
      if (defaultUser) set("assignedTo", defaultUser.id);
    }).catch(() => {});
  }, [reporter]);

  useEffect(() => {
    if (form.status === "Site Visit") setForm((current) => ({ ...current, stage: "Site Scheduled" }));
    if (form.status === "Confirmed") setForm((current) => ({ ...current, stage: "Site Scheduled" }));
    if (form.status === "Converted") setForm((current) => ({ ...current, stage: "Converted" }));
    if (form.status === "Not Interested") setForm((current) => ({ ...current, stage: "Lost / Dead" }));
  }, [form.status]);

  const showVisit = form.status === "Site Visit" || (form.activity === "Site Visit" && ["Booking", "Taken to Site"].includes(form.visitStage));
  const showFollowup = form.activity === "Follow-up"
    || (!!form.status && !["Converted", "Not Interested"].includes(form.status) && form.stage !== "Lost / Dead");
  const chosenContact = contacts.find((contact) => contact.key === form.contactKey);
  const selectedProject = projects.find((project) => project.id === form.projectId);
  const filteredContacts = contacts.filter((contact) => {
    const query = search.toLowerCase();
    const matches = `${contact.name} ${contact.phone} ${contact.sourceLabel}`.toLowerCase().includes(query);
    return matches && (form.activity !== "Event Lead" || !form.eventId || contact.eventId === form.eventId);
  }).slice(0, 8);

  const activityOptions = useMemo(() => {
    switch (form.activity) {
      case "Call": return { label: "Purpose", values: ["Enquiry", "Booking", "Information", "Payment"] };
      case "Office Visit": return { label: "Purpose", values: ["Enquiry", "Booking", "Payment", "Information", "Document collection"] };
      case "Online Enquiry": return { label: "Purpose", values: ["Enquiry", "Booking", "Information", "Payment", "Feedback"] };
      case "Customer Referral": return { label: "Purpose", values: ["Enquiry", "Booking", "Information"] };
      default: return null;
    }
  }, [form.activity]);

  async function ensureLeadContact() {
    if (form.contactMode === "new") {
      if (!form.fullName.trim() || !form.phone.trim()) return null;
      const parts = form.fullName.trim().split(/\s+/);
      const { data, error: insertError } = await supabase.from("lead_contacts").insert({
        first_name: parts.shift() || form.fullName.trim(),
        last_name: parts.join(" "), phone: form.phone.trim(), email: form.email.trim() || null,
        event_id: form.leadSource === "Event" ? form.eventId || null : null,
        note: [form.area && `Area: ${form.area}`, form.altPhone && `Alt: ${form.altPhone}`, `Source: ${form.leadSource}`].filter(Boolean).join(" · "),
        status: "contacts",
      }).select("id").single();
      if (insertError) throw insertError;
      return data.id as number;
    }
    if (!chosenContact) return null;
    if (chosenContact.leadId) return chosenContact.leadId;
    const parts = chosenContact.name.trim().split(/\s+/);
    const { data, error: insertError } = await supabase.from("lead_contacts").insert({
      first_name: parts.shift() || chosenContact.name,
      last_name: parts.join(" "), phone: chosenContact.phone, email: chosenContact.email || null,
      note: `Imported from ${chosenContact.sourceLabel}`, status: "contacts",
    }).select("id").single();
    if (insertError) throw insertError;
    return data.id as number;
  }

  async function save(keepOpen = false) {
    setError("");
    setSaving(true);
    try {
      const contactId = await ensureLeadContact();
      const { data: auth } = await supabase.auth.getUser();
      let siteVisitId: number | null = null;
      if (showVisit && form.visitDate && form.visitTime) {
        const { data: visit, error: visitError } = await supabase.from("lead_site_visits").insert({
          project_id: form.projectId > 0 ? form.projectId : null, contact_id: contactId,
          location: selectedProject?.location || selectedProject?.name || "Project site",
          scheduled_at: new Date(`${form.visitDate}T${form.visitTime}`).toISOString(),
          capacity: Math.max(1, Number(form.visitors) || 1), contacts_count: 1,
          visitors_count: Math.max(1, Number(form.visitors) || 1), transport: form.transport,
          pickup_point: form.pickupPoint, visit_outcome: form.visitOutcome || null,
          details: form.outcome, reported_by: form.reportedBy || reporter, created_by: auth.user?.id ?? null,
        }).select("id").single();
        if (visitError) throw visitError;
        siteVisitId = visit.id;
      }
      const subtype = form.activity === "Call" ? `${form.purpose} · ${form.direction} · ${form.result}`
        : form.activity === "Online Enquiry" ? `${form.onlineChannel} · ${form.purpose}`
        : form.activity === "Site Visit" ? form.visitStage
        : form.activity === "Follow-up" ? form.followupOn
        : form.activity === "Payment" ? form.paymentType : form.purpose;
      const { error: logError } = await supabase.from("lead_outreach_logs").insert({
        occurred_at: new Date(`${form.date || localDate()}T${form.time || localTime()}`).toISOString(),
        activity_type: form.activity || null, activity_subtype: subtype || null, activity_purpose: form.purpose || null,
        contact_id: contactId, contact_type: form.contactType,
        outcome: form.outcome.trim() || null, status: form.status || null, pipeline_stage: form.stage || null,
        reported_by: form.reportedBy || reporter, reported_by_user_id: auth.user?.id ?? null,
        signed_by: form.signedBy || reporter,
        project_id: form.projectId > 0 ? form.projectId : null, plot_reference: form.plotReference || null,
        budget_range: form.budgetRange, payment_preference: form.paymentPreference,
        site_visit_id: siteVisitId, notes: form.notes.trim() || null,
        lost_reason: form.lostReason === "Other" ? form.otherLostReason : form.lostReason || null,
        followup_at: showFollowup && form.followupDate ? new Date(`${form.followupDate}T${form.followupTime || "09:00"}`).toISOString() : null,
        followup_type: showFollowup && form.followupType ? (form.followupType === "Other" ? form.followupOther : form.followupType) : null,
        assigned_to: showFollowup && form.assignedTo ? form.assignedTo : null,
        assigned_to_name: showFollowup && form.assignedTo ? users.find((user) => user.id === form.assignedTo)?.label ?? null : null,
        priority: showFollowup ? form.priority : null,
        remind_via: showFollowup ? form.remindVia : [], reminder_status: showFollowup ? "open" : null,
        metadata: {
          onlineChannel: form.onlineChannel, adReference: form.adReference, paymentType: form.paymentType,
          amount: form.amount, whatsappMessage: form.whatsappMessage, leadSource: form.leadSource,
          anotherProjectId: form.anotherProjectId || null,
        },
      });
      if (logError) throw logError;
      if (contactId) await supabase.from("lead_contacts").update({
        status: form.stage === "Site Scheduled" ? "site_scheduled" : form.stage === "Converted" ? "converted" : form.stage === "Lost / Dead" ? "lost" : "contacted",
        site_visit_date: showVisit ? form.visitDate : null,
      }).eq("id", contactId);
      onSaved(keepOpen);
      if (keepOpen) {
        setForm((current) => ({ ...initialForm(), date: current.date, reportedBy: current.reportedBy, signedBy: current.signedBy }));
        setSearch("");
      }
    } catch (err: any) {
      setError(err?.message ?? "Unable to save this outreach entry.");
    } finally {
      setSaving(false);
    }
  }

  const activityDetail = (
    <div className="mt-3 rounded-xl border border-dashed border-violet-300 bg-violet-50/60 p-3">
      {form.activity === "Online Enquiry" && <>
        <Label>Online Channel</Label>
        <ChipGroup options={["WhatsApp", "Facebook", "Website", "E-mail", "Instagram / TikTok"]} value={form.onlineChannel} onChange={(v) => set("onlineChannel", v)} />
      </>}
      {form.activity === "Call" && <div className="mb-3 grid grid-cols-2 gap-3">
        <div><Label>Call Direction</Label><ChipGroup options={["Outgoing", "Incoming"]} value={form.direction} onChange={(v) => set("direction", v)} /></div>
        <div><Label>Call Result</Label><select className={fieldClass} value={form.result} onChange={(e) => set("result", e.target.value)}>{["Answered", "No answer", "Busy", "Switched off", "Wrong number", "Call back later"].map((v) => <option key={v}>{v}</option>)}</select></div>
      </div>}
      {form.activity === "Customer Referral" && <div className="mb-3"><Label>Referred By</Label><input className={fieldClass} placeholder="Search member, client or agent" value={form.referrer} onChange={(e) => set("referrer", e.target.value)} /></div>}
      {form.activity === "Site Visit" && <><Label>Visit Stage</Label><ChipGroup options={["Booking", "Taken to Site", "Feedback"]} value={form.visitStage} onChange={(v) => set("visitStage", v)} /></>}
      {form.activity === "Follow-up" && <><Label>Follow-up On</Label><ChipGroup options={["Lead", "Payment", "Customer (after-sale)"]} value={form.followupOn} onChange={(v) => set("followupOn", v)} /></>}
      {form.activity === "Event Lead" && <><Label>Event</Label><select className={fieldClass} value={form.eventId} onChange={(e) => set("eventId", Number(e.target.value))}><option value={0}>Select event</option>{events.map((event) => <option key={event.id} value={event.id}>{event.name} · {event.date}</option>)}</select></>}
      {form.activity === "Payment" && <div className="grid grid-cols-2 gap-3"><div><Label>Payment Type</Label><select className={fieldClass} value={form.paymentType} onChange={(e) => set("paymentType", e.target.value)}>{["Deposit", "Instalment", "Full payment", "Refund request"].map((v) => <option key={v}>{v}</option>)}</select></div><div><Label>Amount (KES)</Label><input type="number" className={fieldClass} value={form.amount} onChange={(e) => set("amount", e.target.value)} placeholder="Optional" /></div></div>}
      {activityOptions && <div className={form.activity === "Online Enquiry" ? "mt-3" : ""}><Label>{activityOptions.label}</Label><ChipGroup options={activityOptions.values} value={form.purpose} onChange={(v) => set("purpose", v)} /></div>}
      {form.activity === "Online Enquiry" && <div className="mt-3"><Label>Ad / Post Reference</Label><input className={fieldClass} value={form.adReference} onChange={(e) => set("adReference", e.target.value)} placeholder="e.g. Phase 3 flyer" /></div>}
    </div>
  );

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/55 p-2 backdrop-blur-[2px] md:p-5">
      <div className="flex max-h-[96vh] w-full max-w-[1480px] flex-col overflow-hidden rounded-2xl border border-white/70 bg-white shadow-[0_28px_80px_rgba(30,20,60,.35)]">
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-600 text-white"><Calendar size={19} /></div>
            <div><h3 className="text-lg font-extrabold text-slate-950">New Log Entry</h3><p className="text-[11px] text-slate-500">Record an interaction, move the lead along the pipeline and schedule the next action.</p></div>
          </div>
          <div className="flex items-center gap-3"><span className="hidden rounded-full bg-violet-50 px-3 py-1 text-[10px] font-bold text-violet-700 sm:block">Draft · auto-saved</span><button onClick={onClose} className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-50"><X size={15} /></button></div>
        </header>

        <div className="border-b border-slate-200 bg-slate-50/70 px-5 py-3">
          <div className="mx-auto flex max-w-6xl items-center">
            {["Activity", "Contact", "Interest & Outcome", "Site Visit", "Follow-up & Reminder"].map((step, index) => (
              <React.Fragment key={step}>
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold ${index < 3 ? "border-violet-600 bg-violet-600 text-white" : "border-violet-300 bg-white text-violet-700"}`}>{index < 3 ? <Check size={12} /> : index + 1}</span>
                  <div className="hidden min-w-0 md:block"><p className="truncate text-[11px] font-bold text-slate-800">{step}</p><p className="text-[9px] text-slate-400">{["What happened", "Who & source", "Project · stage · status", "If booked", "Next action"][index]}</p></div>
                </div>
                {index < 4 && <div className={`mx-2 h-px flex-1 ${index < 3 ? "bg-violet-500" : "bg-slate-200"}`} />}
              </React.Fragment>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error && <div className="sticky top-0 z-20 border-b border-red-200 bg-red-50 px-5 py-2 text-center text-xs font-semibold text-red-700">{error}</div>}
          <div className="grid grid-cols-1 divide-y divide-slate-200 xl:grid-cols-[1.08fr_1.08fr_1fr] xl:divide-x xl:divide-y-0">
            <div className="p-5">
              <SectionTitle number={1} title="Activity" note="What happened today" />
              <div className="mb-3 grid grid-cols-2 gap-3">
                <div><Label>Date</Label><input type="date" className={fieldClass} value={form.date} onChange={(e) => set("date", e.target.value)} /></div>
                <div><Label>Time</Label><input type="time" className={fieldClass} value={form.time} onChange={(e) => set("time", e.target.value)} /></div>
              </div>
              <Label>Activity Type</Label>
              <select className={fieldClass} value={form.activity} onChange={(e) => set("activity", e.target.value)}>
                <option value="">Select activity type</option>
                {ACTIVITY.map(({ id }) => <option key={id} value={id}>{id}</option>)}
              </select>
              {form.activity && activityDetail}

              <div className="my-5 h-px bg-slate-200" />
              <SectionTitle number={2} title="Contact / Prospect" note="Search events, leads & clients" />
              <div className="mb-3 grid grid-cols-2 rounded-lg bg-slate-100 p-1">
                <button type="button" onClick={() => set("contactMode", "existing")} className={`rounded-md py-2 text-[11px] font-bold ${form.contactMode === "existing" ? "bg-white text-violet-700 shadow-sm" : "text-slate-500"}`}>Existing contact</button>
                <button type="button" onClick={() => set("contactMode", "new")} className={`rounded-md py-2 text-[11px] font-bold ${form.contactMode === "new" ? "bg-white text-violet-700 shadow-sm" : "text-slate-500"}`}>+ New contact</button>
              </div>
              {form.contactMode === "existing" ? <>
                <div className="relative"><Search size={14} className="absolute left-3 top-3 text-slate-400" /><input className={`${fieldClass} pl-9`} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, phone or event…" /></div>
                {search && !chosenContact && <div className="mt-1 max-h-44 overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">{filteredContacts.map((contact) => <button type="button" key={contact.key} onClick={() => { set("contactKey", contact.key); setSearch(""); }} className="flex w-full items-center justify-between gap-3 border-b border-slate-100 px-3 py-2.5 text-left last:border-0 hover:bg-slate-50"><div><p className="text-xs font-bold text-slate-800">{contact.name}</p><p className="text-[10px] text-slate-500">{contact.phone}</p></div><span className={`rounded border px-2 py-0.5 text-[9px] font-bold ${SOURCE_COLORS[contact.source]}`}>{contact.source}</span></button>)}</div>}
                {chosenContact && <div className="mt-3 rounded-xl border border-slate-200 p-3"><div className="flex items-start gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-full bg-violet-100 text-xs font-extrabold text-violet-700">{chosenContact.name.split(" ").map((v) => v[0]).slice(0, 2).join("")}</div><div className="min-w-0 flex-1"><p className="text-xs font-extrabold text-slate-900">{chosenContact.name}</p><p className="text-[10px] text-slate-500">{chosenContact.phone}{chosenContact.email ? ` · ${chosenContact.email}` : ""}</p><span className={`mt-1 inline-block rounded border px-2 py-0.5 text-[9px] font-bold ${SOURCE_COLORS[chosenContact.source]}`}>{chosenContact.source} · {chosenContact.sourceLabel}</span></div><button type="button" onClick={() => set("contactKey", "")} className="text-[10px] font-bold text-violet-700">Change</button></div></div>}
              </> : <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2"><Label>Full Name</Label><input className={fieldClass} value={form.fullName} onChange={(e) => set("fullName", e.target.value)} /></div>
                <div><Label>Phone Number</Label><input className={fieldClass} value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="07XX XXX XXX" /></div>
                <div><Label>Alt. Phone</Label><input className={fieldClass} value={form.altPhone} onChange={(e) => set("altPhone", e.target.value)} /></div>
                <div><Label>E-mail</Label><input type="email" className={fieldClass} value={form.email} onChange={(e) => set("email", e.target.value)} /></div>
                <div><Label>Location / Area</Label><input className={fieldClass} value={form.area} onChange={(e) => set("area", e.target.value)} placeholder="e.g. Rongai" /></div>
                <div className="col-span-2"><Label>Lead Source</Label><select className={fieldClass} value={form.leadSource} onChange={(e) => set("leadSource", e.target.value)}><option value="">Select source</option>{["Event", "Walk-in", "Call-in", "WhatsApp", "Facebook", "Website", "Referral", "Other"].map((v) => <option key={v}>{v}</option>)}</select></div>
                {form.leadSource === "Event" && <div className="col-span-2"><Label>Event</Label><select className={fieldClass} value={form.eventId} onChange={(e) => set("eventId", Number(e.target.value))}><option value={0}>Select event</option>{events.map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}</select></div>}
              </div>}
              <div className="mt-3"><Label>Contact Type</Label><select className={fieldClass} value={form.contactType} onChange={(e) => set("contactType", e.target.value)}>{["Prospect", "Client", "Member/Shareholder", "Agent"].map((v) => <option key={v}>{v}</option>)}</select></div>
            </div>

            <div className="p-5">
              <SectionTitle number={3} title="Interest & Outcome" note="Where the lead stands" />
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Project of Interest</Label><select className={fieldClass} value={form.projectId} onChange={(e) => set("projectId", Number(e.target.value))}><option value={0}>Select project</option><option value={-1}>General / Not decided</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div>
                <div><Label>Plot Size / Plot No.</Label><input className={fieldClass} value={form.plotReference} onChange={(e) => set("plotReference", e.target.value)} placeholder="50×100 · Plot 12" /></div>
                <div><Label>Budget Range</Label><select className={fieldClass} value={form.budgetRange} onChange={(e) => set("budgetRange", e.target.value)}>{["Below 500K", "500K-1M", "1M-2M", "2M-5M", "Above 5M", "Not shared"].map((v) => <option key={v}>{v}</option>)}</select></div>
                <div><Label>Payment Preference</Label><select className={fieldClass} value={form.paymentPreference} onChange={(e) => set("paymentPreference", e.target.value)}>{["Cash", "Instalments 6 mo", "12 mo", "24 mo", "Not decided"].map((v) => <option key={v}>{v}</option>)}</select></div>
              </div>
              <div className="mt-4"><Label>Pipeline Stage</Label><div className="grid grid-cols-4 overflow-hidden rounded-lg bg-slate-100">{STAGES.map((stage) => <button type="button" key={stage} onClick={() => set("stage", stage)} className={`relative px-2 py-2 text-[9px] font-bold transition ${form.stage === stage ? "bg-violet-600 text-white" : "text-slate-500 hover:bg-slate-200"}`}>{stage}</button>)}</div></div>
              <div className="mt-4"><Label>Status of this interaction</Label><div className="flex flex-wrap gap-1.5">{STATUS.map((status) => <button type="button" key={status} onClick={() => set("status", status)} className={`rounded-md border px-3 py-2 text-[10px] font-bold ${form.status === status ? status === "Not Interested" ? "border-red-500 bg-red-50 text-red-700" : "border-violet-600 bg-violet-50 text-violet-700" : "border-slate-200 text-slate-500"}`}>{status}</button>)}</div></div>
              <div className="mt-4"><Label>Outcome / Next Step</Label><input className={`${fieldClass} focus:border-violet-600`} value={form.outcome} onChange={(e) => set("outcome", e.target.value)} placeholder="e.g. Booked site visit Sat" /></div>
              {(form.status === "Not Interested" || form.stage === "Lost / Dead") && <div className="mt-3"><Label>Lost Reason</Label><select className={fieldClass} value={form.lostReason} onChange={(e) => set("lostReason", e.target.value)}><option value="">Select reason</option>{["Budget", "Location", "Timing", "Bought elsewhere", "No response", "Other"].map((v) => <option key={v}>{v}</option>)}</select>{form.lostReason === "Other" && <input className={`${fieldClass} mt-2`} value={form.otherLostReason} onChange={(e) => set("otherLostReason", e.target.value)} placeholder="Type reason" />}</div>}
              <div className="mt-4"><div className="flex justify-between"><Label>Details / Notes</Label><span className="text-[9px] text-slate-400">{form.notes.length} / 500</span></div><textarea rows={5} maxLength={500} className="w-full resize-none rounded-lg border border-slate-200 p-3 text-xs outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100" value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Type freely…" /></div>
              <div className="mt-3 rounded-lg bg-slate-50 p-3 text-[10px] leading-relaxed text-slate-500">Status and pipeline stage stay in sync automatically. Site Visit opens the booking panel; Converted and Lost make follow-up optional.</div>
            </div>

            <div className="space-y-4 bg-slate-50/40 p-5">
              {showVisit && <section className="rounded-xl border border-violet-200 bg-violet-50/40 p-4">
                <SectionTitle number={4} title="Site Visit Booking" note="CREATES SITE VISIT RECORD" />
                <div className="grid grid-cols-2 gap-3">
                  <div><Label>Visit Date</Label><input type="date" className={fieldClass} value={form.visitDate} onChange={(e) => set("visitDate", e.target.value)} /></div>
                  <div><Label>Visit Time</Label><input type="time" className={fieldClass} value={form.visitTime} onChange={(e) => set("visitTime", e.target.value)} /></div>
                  <div><Label>No. of Visitors</Label><input type="number" min={1} className={fieldClass} value={form.visitors} onChange={(e) => set("visitors", e.target.value)} /></div>
                  <div><Label>Transport</Label><select className={fieldClass} value={form.transport} onChange={(e) => set("transport", e.target.value)}>{["Company van", "Own transport", "Pick-up arranged"].map((v) => <option key={v}>{v}</option>)}</select></div>
                  <div><Label>Pick-up Point</Label><input className={fieldClass} value={form.pickupPoint} onChange={(e) => set("pickupPoint", e.target.value)} /></div>
                  <div><Label>Visit Outcome</Label><select className={fieldClass} value={form.visitOutcome} onChange={(e) => set("visitOutcome", e.target.value)}><option value="">After visit…</option>{["Attended - interested", "Attended - booked plot", "Attended - not interested", "Did not show", "Rescheduled"].map((v) => <option key={v}>{v}</option>)}</select></div>
                </div>
              </section>}
              {showFollowup && <section className="rounded-xl border border-amber-200 bg-amber-50/40 p-4">
                <SectionTitle number={5} title="Follow-up & Reminder" note="REQUIRED UNLESS CONVERTED / LOST" color="amber" />
                <div className="grid grid-cols-2 gap-3">
                  <div><Label>Follow-up Date</Label><input type="date" className={fieldClass} value={form.followupDate} onChange={(e) => set("followupDate", e.target.value)} /></div>
                  <div><Label>Time</Label><input type="time" className={fieldClass} value={form.followupTime} onChange={(e) => set("followupTime", e.target.value)} /></div>
                  <div><Label>Follow-up Type</Label><select className={fieldClass} value={form.followupType} onChange={(e) => set("followupType", e.target.value)}><option value="">Select follow-up type</option>{["Call back", "Send prices / brochure", "Confirm site visit", "Book site visit", "Office meeting", "Interest in another project", "Payment follow-up", "Document / title follow-up", "Other"].map((v) => <option key={v}>{v}</option>)}</select></div>
                  <div><Label>Assign To</Label><select className={fieldClass} value={form.assignedTo} onChange={(e) => set("assignedTo", e.target.value)}><option value="">Select user</option>{users.map((user) => <option key={user.id} value={user.id}>{user.label}</option>)}</select></div>
                  {form.followupType === "Interest in another project" && <div className="col-span-2"><Label>Project</Label><select className={fieldClass} value={form.anotherProjectId} onChange={(e) => set("anotherProjectId", Number(e.target.value))}><option value={0}>Select another project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div>}
                  {form.followupType === "Other" && <div className="col-span-2"><Label>Follow-up action</Label><input className={fieldClass} value={form.followupOther} onChange={(e) => set("followupOther", e.target.value)} /></div>}
                </div>
                <div className="mt-3"><Label>Priority</Label><div className="grid grid-cols-3 gap-1.5">{["Low", "Normal", "High"].map((priority) => <button type="button" key={priority} onClick={() => set("priority", priority)} className={`rounded-lg border py-2 text-[10px] font-bold ${form.priority === priority ? "border-amber-500 bg-amber-50 text-amber-700" : "border-slate-200 bg-white text-slate-600"}`}>{priority}</button>)}</div></div>
                <div className="mt-3"><Label>Remind via</Label><div className="flex flex-wrap gap-x-3 gap-y-2">{["In-app bell", "SMS to staff", "E-mail", "WhatsApp to client"].map((method) => <label key={method} className="flex items-center gap-1.5 text-[10px] font-medium text-slate-600"><input type="checkbox" checked={form.remindVia.includes(method)} onChange={() => set("remindVia", form.remindVia.includes(method) ? form.remindVia.filter((v) => v !== method) : [...form.remindVia, method])} className="accent-amber-500" />{method}</label>)}</div></div>
                <div className="mt-3 flex gap-3 rounded-lg border border-amber-200 bg-white p-3"><div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500 text-white"><Clock size={15} /></div><div><p className="text-[11px] font-bold text-slate-800">Reminder set for {form.followupDate || "—"}, {form.followupTime}</p><p className="mt-0.5 text-[10px] leading-relaxed text-slate-500">This will appear in the assigned user's bell, dashboard and Due today list.</p></div></div>
              </section>}
              {!showVisit && <div className="rounded-xl border border-dashed border-slate-200 bg-white p-5 text-center"><MapPin size={20} className="mx-auto mb-2 text-slate-300" /><p className="text-[11px] font-bold text-slate-500">Site visit panel is hidden</p><p className="text-[10px] text-slate-400">Choose Site Visit status or a Site Visit booking activity to open it.</p></div>}
            </div>
          </div>
        </div>

        <footer className="flex flex-col gap-3 border-t border-slate-200 bg-white px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <div><Label>Reported By</Label><input className={`${fieldClass} min-w-56 bg-slate-50`} value={form.reportedBy} readOnly /></div>
            <div><Label>Signed By</Label><input className={`${fieldClass} min-w-56 bg-slate-50`} value={form.signedBy} readOnly /></div>
            <span className="hidden pt-5 text-[10px] text-slate-400 lg:block">Auto-filled from the logged-in user</span>
          </div>
          <div className="flex justify-end gap-2"><button onClick={onClose} className="rounded-lg border border-slate-200 px-4 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50">Cancel</button><button disabled={saving} onClick={() => save(true)} className="rounded-lg border border-violet-200 bg-violet-50 px-4 py-2.5 text-xs font-bold text-violet-700 disabled:opacity-50">Save & New</button><button disabled={saving} onClick={() => save(false)} className="flex items-center gap-2 rounded-lg bg-violet-600 px-5 py-2.5 text-xs font-bold text-white shadow-lg shadow-violet-200 hover:bg-violet-700 disabled:opacity-50">{saving ? "Saving…" : "Save Entry"}<ArrowRight size={13} /></button></div>
        </footer>
      </div>
    </div>
  );
}
