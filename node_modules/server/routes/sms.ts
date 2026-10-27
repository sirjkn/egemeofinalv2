import { Router, Request, Response } from "express";

const router = Router();

interface SmsBody {
  provider: "africastalking" | "oramobile";
  to: string;
  message: string;
  africastalking?: { apiKey: string; username: string; senderId: string };
  oramobile?: { apiKey: string; senderId: string; apiUrl: string };
}

router.post("/send", async (req: Request, res: Response) => {
  const body = req.body as SmsBody;
  const { provider, to, message } = body;

  if (!to || !message) {
    return res.status(400).json({ success: false, error: "Missing to or message" });
  }

  const phone = to.replace(/^\+?0/, "254").replace(/^\+/, "");

  try {
    if (provider === "africastalking") {
      const cfg = body.africastalking;
      if (!cfg?.apiKey || !cfg?.username) {
        return res.status(400).json({ success: false, error: "Africa's Talking apiKey and username are required" });
      }
      const atRes = await fetch("https://api.africastalking.com/version1/messaging", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          apiKey: cfg.apiKey,
        },
        body: new URLSearchParams({
          username: cfg.username,
          to: `+${phone}`,
          message,
          ...(cfg.senderId ? { from: cfg.senderId } : {}),
        }).toString(),
      });
      const text = await atRes.text();
      if (!atRes.ok) throw new Error(`Africa's Talking error: ${atRes.status} ${text}`);
      return res.json({ success: true, response: text });
    }

    if (provider === "oramobile") {
      const cfg = body.oramobile;
      if (!cfg?.apiKey) {
        return res.status(400).json({ success: false, error: "OramaMobile apiKey is required" });
      }
      const url = cfg.apiUrl || "https://sms.oramobile.co.ke/api/sms";
      const orRes = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({ to: phone, message, from: cfg.senderId || "EgemeoArdhi" }),
      });
      const text = await orRes.text();
      if (!orRes.ok) throw new Error(`OramaMobile error: ${orRes.status} ${text}`);
      return res.json({ success: true, response: text });
    }

    return res.status(400).json({ success: false, error: "Unknown provider" });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
