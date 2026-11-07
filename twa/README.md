# Tungbola — Android app (Trusted Web Activity)

A native Android wrapper that opens the deployed PWA full-screen (no browser UI) via Chrome's
Trusted Web Activity. All game/API logic stays on the website, so web updates ship instantly;
the app only needs re-publishing when you change native settings (icon, name, version).

## One-time setup
1. **Domain**: set `twaHost` in `gradle.properties` (or the `TWA_HOST` repo variable on GitHub) to the
   deployed domain, e.g. `tungbola.vercel.app`. TWA requires HTTPS.
2. **Upload keystore** (keep it safe, back it up):
   ```bash
   keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
   base64 -w0 upload.jks   # paste into the ANDROID_KEYSTORE_BASE64 secret
   ```
   GitHub → Settings → Secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
   `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
3. **Build**: GitHub → Actions → "Build Android app" → Run workflow. Download the `tungbola-android`
   artifact (`.aab` for Play, `.apk` for sideload testing).
   Local build (needs Android SDK + JDK 17): `cd twa && ./gradlew bundleRelease assembleRelease`.

## Play Console
1. Create the app, upload the `.aab` (enable **Play App Signing**).
2. Play Console → Setup → App signing → copy the **SHA-256 certificate fingerprint** of the *app signing key*.
3. Put it in `public/.well-known/assetlinks.json` (replace the placeholder; keep `package_name` equal to
   `twaApplicationId`), deploy to Vercel, and check `https://<host>/.well-known/assetlinks.json` returns JSON.
   Without this the app shows a browser URL bar instead of full-screen.
   (If you also sideload the upload-key APK, add that fingerprint too.)
4. Store listing needs: 512×512 icon (`public/icons/icon-512.png`), 1024×500 feature graphic,
   ≥2 phone screenshots, short/full description, **privacy policy URL**, Data safety form, content rating.
5. Bump `twaVersionCode` for every upload.

## Policy warning
The app collects payment through UPI for game sheets. Google Play generally requires Play Billing for
digital goods/in-app content; external payment flows can get an app rejected. Review the Payments policy
before submitting (or position/justify the app accordingly).
