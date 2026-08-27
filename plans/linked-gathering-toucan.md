# Admin Password Reset via Supabase Edge Function

## Context

The previous "Reveal Member Password" card is being removed because **Supabase passwords cannot be read** — they are stored as one-way bcrypt hashes and there is no API to retrieve them.

The correct admin capability is **resetting** a member's password to a known temporary value, then notifying the member via SMS. Since the app runs in Figma Make (no deployed Node.js server), the reset must go through a Supabase Edge Function — which has server-side access to `SUPABASE_SERVICE_ROLE_KEY` and the Auth Admin API (`supabase.auth.admin.updateUserById`).

---

## Changes

### 1. New Edge Function — `supabase/functions/admin-reset-password/index.ts`

Follow the exact pattern used in `mpesa-stk/index.ts` and `sms-reminder/index.ts`:

```ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  const { userId, newPassword } = await req.json();
  if (!userId || !newPassword || newPassword.length < 6)
    return new Response(JSON.stringify({ success: false, error: "userId and newPassword (min 6 chars) required" }), { status: 400, headers: { "Content-Type": "application/json" } });

  const { error } = await supabase.auth.admin.updateUserById(userId, { password: newPassword });
  if (error)
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 400, headers: { "Content-Type": "application/json" } });

  // Clear flag so member is prompted to change password on next login
  await supabase.from("user_profiles").update({ password_changed: false }).eq("id", userId);

  return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json" } });
});
```

### 2. Replace old card in `src/app/pages/SettingsPage.tsx`

**Remove** the entire `RevealMemberPasswordCard` function and its `UserProfileRow` interface.

**Add `AdminPasswordResetCard`** — a clean single-purpose card.

**State:**
- `users` — loaded from `user_profiles` (id, full_name, email, role, member_id) on mount
- `selected` + `phone` — picked member + their phone from `shareholders`/`clients`/`investors`
- `password` — temp password; auto-generates 6-digit OTP when a member is picked
- `showPw`, `editPhone`, `resetting`, `smsSending`, `msg`

**Actions:**
- **Refresh icon** next to password field → regenerate OTP: `Math.floor(100000 + Math.random() * 900000).toString()`
- **Reset Password** button → `supabase.functions.invoke("admin-reset-password", { body: { userId: selected.id, newPassword: password } })`
- **Reset & Send SMS** button → reset first, then `sendSms(phone, message)` with the temp password
  - Message: `Hi [FirstName], your SACCO password has been reset. Temp password: [otp]. Login with your phone number and change it after login.`

**No server URL field** — the Edge Function call goes through the existing `supabase` client automatically.

**Wire into tools tab** — replace `<RevealMemberPasswordCard />` with `<AdminPasswordResetCard />`.

---

## Reused utilities
- `sendSms(phone, message)` — `src/lib/sms.ts`, already imported in SettingsPage
- `supabase.functions.invoke()` — no new imports; `supabase` is already imported
- Phone lookup: `supabase.from(table).select("phone").eq("id", member_id).maybeSingle()` — same pattern as deleted card
- All icons (`KeyRound`, `RefreshCw`, `Eye`, `EyeOff`, `MessageSquare`, `CheckCircle`, `XCircle`, `Loader2`, `Search`, `X`, `Phone`, `Edit2`) — already imported

---

## Critical Files
- `supabase/functions/admin-reset-password/index.ts` — **new file**
- `src/app/pages/SettingsPage.tsx` — remove `RevealMemberPasswordCard` + `UserProfileRow`, add `AdminPasswordResetCard`, update tools tab reference

---

## Verification
1. App Maintenance → Data Tools → find the new "Admin Password Reset" card
2. Search a member → 6-digit OTP auto-appears in password field
3. Click Show → OTP visible in plain text; click Refresh to regenerate
4. Click **Reset Password** → success message; member can now log in with the OTP
5. Click **Reset & Send SMS** → same as above + member receives SMS with temp password
6. Member logs in with OTP → prompted to set a new personal password (`password_changed = false`)
