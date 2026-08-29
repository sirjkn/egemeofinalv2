# Two Bug Fixes: Login Flash + Manual Mpesa Visibility

## Context

Two unrelated bugs reported by the user:

1. **Login flash**: After logging in as shareholder/client/receptionist, the admin dashboard is briefly shown for ~3 seconds before the correct member dashboard appears. This is a race condition — the session is set synchronously but the profile is fetched asynchronously, so there's a window where `profile === null` and `DashboardPage` treats null as "admin".

2. **Manual Mpesa for non-admins**: The "✍️ Manual Code" sub-tab inside the M-Pesa payment section is visible to co-owners and other non-admin users when making plot payments. It should only appear for admin.

---

## Fix 1 — Login Flash (`src/app/App.tsx`)

### Root cause
`onAuthStateChange` calls `setSession(s)` synchronously, then begins an async `fetchProfile()`. During that async gap, `profile === null` and `DashboardPage` renders `AdminDashboard` because of:
```ts
if (!profile || profile.role === "admin" || profile.role === "reception") return <AdminDashboard />;
```

### Changes

**A. `App()` component — add a loading guard (~line 7399)**

The `App()` function already has `authReady` and `session` state. Add a check:
```ts
// session exists but profile not yet loaded — show loading spinner
if (authReady && session && !profile) {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-white">
      <Loader2 size={28} className="animate-spin text-gray-300" />
    </div>
  );
}
```
Place this **after** the `if (!authReady)` splash guard and **before** the `if (profile && !profile.password_changed)` password-change check.

**B. `DashboardPage` — harden null profile handling (~line 3919)**

Change:
```ts
if (!profile || profile.role === "admin" || profile.role === "reception") return <AdminDashboard />;
```
To:
```ts
if (!profile) return null;  // still loading — App() spinner covers this
if (profile.role === "admin" || profile.role === "reception") return <AdminDashboard />;
```

---

## Fix 2 — Manual Mpesa tab (`src/app/pages/ProjectsPage.tsx` + `src/app/App.tsx`)

### Two locations with the same pattern

Both `PlotPaymentModal` (ProjectsPage.tsx ~line 606) and `PaymentModal` (App.tsx ~line 5682) render the STK Push / Manual Code sub-tab toggle unconditionally inside `{method === "mpesa" && ...}`. The Manual Code tab must be hidden for non-admin.

**`PlotPaymentModal` in `ProjectsPage.tsx` (~line 606):**
The component already has `isAdmin` prop. Wrap the "✍️ Manual Code" tab button and its content with `{isAdmin && ...}`. When `isAdmin` is false, skip rendering the tab toggle entirely (user only sees STK Push, no tab UI needed).

Pattern:
```tsx
{method === "mpesa" && (
  <div>
    {isAdmin && (
      <div className="flex rounded-xl overflow-hidden border mb-3">
        <button ...>📱 STK Push</button>
        <button ...>✍️ Manual Code</button>
      </div>
    )}
    {/* STK Push content always shown when method=mpesa */}
    {(!isAdmin || mpesaTab === "stk") && <StkPushSection />}
    {isAdmin && mpesaTab === "manual" && <ManualCodeSection />}
  </div>
)}
```

**`PaymentModal` in `App.tsx` (~line 5682):**
The component already has `const isAdmin = profile?.role === "admin"`. Apply the same gate — wrap the tab toggle and manual code section with `{isAdmin && ...}`.

---

## Critical Files
- `src/app/App.tsx` — `App()` loading guard + `DashboardPage` null guard + `PaymentModal` manual mpesa gate
- `src/app/pages/ProjectsPage.tsx` — `PlotPaymentModal` manual mpesa gate

## Verification
1. Log in as a shareholder → no admin dashboard flash; member dashboard appears immediately
2. Log in as a client → same
3. Log in as receptionist → same  
4. Admin logs in → admin dashboard still appears as before
5. As a shareholder/client with a plot, click "Make Payment" → only STK Push option visible, no "Manual Code" tab
6. As admin on a plot, click payment → both STK Push and Manual Code tabs are visible
