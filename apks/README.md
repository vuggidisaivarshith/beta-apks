# DWARAKA Software Labs — Beta APKs Folder

Drop your Android `.apk` build files directly into this `apks/` folder and push to Git:

```bash
git add apks/
git commit -m "release: add <AppName> <version> beta APK"
git push origin main
```

### How It Works
- Every `.apk` file in `apks/` is **automatically detected** by the portal backend (`GET /api/state`) and listed for beta testers to download on their Android devices.
- Recommended naming convention: `AppName-v1.0.0-beta.apk` (for example `DwarakaPay-v0.4.2-beta.apk`).
- Downloading via `/apks/<filename>.apk` serves the file with `Content-Type: application/vnd.android.package-archive` and `Content-Disposition: attachment` so Android browsers trigger a clean APK download & install prompt.
- Optional sidecar metadata: you can place a `<filename>.json` file next to the `.apk` (e.g., `DwarakaPay-v0.4.2-beta.json`) with fields like `name`, `version`, `stage`, `owner`, `summary`, `changelog`, and `checklist`.
