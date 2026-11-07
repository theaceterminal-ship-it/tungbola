# Tungbola — Deploy to Vercel (Step by Step)

## Step 1 — Upload to GitHub

1. Go to github.com → click **New repository**
2. Name it: `tungbola` → click **Create repository**
3. On the next page click **uploading an existing file**
4. Drag and drop this entire `Tungbola` folder's contents
5. Click **Commit changes**

## Step 2 — Deploy on Vercel

1. Go to vercel.com → click **Add New Project**
2. Click **Import** next to your `tungbola` GitHub repo
3. Leave all settings as default → click **Deploy**
4. Wait ~1 minute → your app is live at `tungbola.vercel.app` (or similar)

## Step 3 — Add Storage (Vercel KV)

1. In Vercel dashboard → go to your project → click **Storage** tab
2. Click **Create Database** → choose **KV (Redis)**
3. Name it `tungbola-kv` → click **Create**
4. Click **Connect to Project** → select your tungbola project → **Connect**
5. This automatically adds the required environment variables

## Step 4 — Set Admin Password

1. In Vercel dashboard → your project → **Settings** → **Environment Variables**
2. Click **Add New**
   - Name: `ADMIN_PASSWORD`
   - Value: (your chosen password)
3. Click **Save**
4. Go to **Deployments** tab → click the three dots on latest deploy → **Redeploy**

## Step 5 — Configure the App

1. Open `yourdomain.vercel.app/admin`
2. Log in with your admin password
3. Go to **Settings** tab
4. Set:
   - **Price per Sheet** (e.g. 5)
   - **UPI ID** (e.g. yourname@paytm)
   - **WhatsApp Number** (with country code, no +, e.g. 919876543210)
5. Click **Save Settings**

## Step 6 — Telegram approvals (one-time, ~5 minutes)

Payment screenshots are sent to **your Telegram** with Approve / Reject buttons.
They are never stored on the server.

1. In Telegram, message **@BotFather** → `/newbot` → follow the prompts → copy the **bot token**.
2. In Vercel → Settings → Environment Variables add:
   - `TELEGRAM_BOT_TOKEN` = the token from BotFather
   - `TELEGRAM_WEBHOOK_SECRET` = any long random string (e.g. 30 random letters/numbers)
3. **Redeploy**, then open this URL once in your browser (it registers the bot's webhook):
   `https://YOURDOMAIN/api/telegram?setup=1&password=YOUR_ADMIN_PASSWORD`
   You should see `"ok": true`.
4. Open your new bot in Telegram and send `/start`. It replies with **your Telegram ID**.
5. Add one more variable: `TELEGRAM_ADMIN_ID` = that number. **Redeploy** again.

Only that Telegram account can approve or reject — anyone else pressing a button is ignored.

## How the payment flow works

1. Player taps **Buy or Renew** → picks a plan → **Proceed to Pay**.
2. Pays with the QR or the **Open UPI app** button, then attaches the payment
   screenshot (UPI transaction ID is optional) and taps **Send for Approval**.
3. A new buyer's key is generated at that moment and shown on their screen. It only
   starts working once you approve.
4. You get a Telegram message with the screenshot, name, plan, amount and UTR.
   Check the money arrived in your bank app, then tap **✅ Approve** or **❌ Reject**
   (reject offers quick reasons). The message updates to show the decision.
   You can also approve/reject from `/admin` → Requests.
5. The player's app checks every few seconds, activates the key / applies the renewal
   automatically, and shows the result. A rejected payment shows your reason.
6. The WhatsApp support link stays on the payment and waiting screens as a fallback.

Notes
- A UTR can't be reused on a second request (blocks re-sending one real payment).
- Unpaid requests expire after 6 hours; requests waiting on you last 72 hours.
- Screenshots live only in your Telegram chat — delete them there whenever you like.

## Updating the app later

Just edit files in GitHub → Vercel auto-redeploys within ~1 minute.
