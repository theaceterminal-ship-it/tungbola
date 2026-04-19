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

## How the payment flow works

1. Player opens the app → loads their ticket PDFs
2. App shows payment screen with your UPI QR + amount
3. Player pays → sends screenshot to your WhatsApp (button on screen)
4. You open `/admin` on your phone → **Sessions** tab
5. Enter player name + sheet count → click **Generate Code**
6. A 6-character code appears (e.g. `TK4X9M`) — tell it to the player
7. Player enters code in app → game unlocks
8. When all prizes are claimed, player sees **End Game** button
9. Clicking it closes their session — they'd need a new code to play again

## Updating the app later

Just edit files in GitHub → Vercel auto-redeploys within ~1 minute.
