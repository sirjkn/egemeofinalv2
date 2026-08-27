import { Router, Request, Response } from "express";

const MPESA_BASE = "https://api.safaricom.co.ke";

const router = Router();

router.post("/stkpush", async (req: Request, res: Response) => {
  const { amount, phone, accountRef, description, config } = req.body;

  if (!config?.consumerKey || !config?.consumerSecret || !config?.shortCode || !config?.passkey) {
    return res.status(400).json({ success: false, error: "Incomplete M-Pesa configuration" });
  }

  const formattedPhone = String(phone).replace(/^\+?254/, "254").replace(/^0/, "254");

  try {
    // Get OAuth token
    const credentials = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString("base64");
    const tokenRes = await fetch(`${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${credentials}` },
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => "");
      return res.status(502).json({ success: false, error: `M-Pesa auth failed: ${tokenRes.status} ${text}` });
    }
    const { access_token } = await tokenRes.json() as any;

    // Build STK push
    const now = new Date();
    const pad = (n: number, l = 2) => String(n).padStart(l, "0");
    const timestamp =
      now.getFullYear() +
      pad(now.getMonth() + 1) +
      pad(now.getDate()) +
      pad(now.getHours()) +
      pad(now.getMinutes()) +
      pad(now.getSeconds());

    const password = Buffer.from(`${config.shortCode}${config.passkey}${timestamp}`).toString("base64");

    const body = {
      BusinessShortCode: config.shortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: Math.ceil(Number(amount)),
      PartyA: formattedPhone,
      PartyB: config.shortCode,
      PhoneNumber: formattedPhone,
      CallBackURL: config.callbackUrl,
      AccountReference: accountRef,
      TransactionDesc: description,
    };

    const stkRes = await fetch(`${MPESA_BASE}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await stkRes.json() as any;
    if (!stkRes.ok || data.errorCode) {
      return res.status(502).json({ success: false, error: data.errorMessage || data.ResponseDescription || "STK Push failed" });
    }
    return res.json({ success: true, ...data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
