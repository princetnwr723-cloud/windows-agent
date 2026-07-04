# Vnus Agent — Desktop App

> Runs on Windows (Mac coming soon). Connects to your Vnus AI dashboard.

## How It Works

1. User downloads & installs `Vnus Agent Setup.exe`
2. Windows asks for admin permissions (required for file system access)
3. Agent opens → Demon splash screen → 10-digit code shown
4. User enters code in dashboard → Add Workspace → Connected!
5. Agent runs silently in system tray forever

## Setup (To Build the .exe)

### Prerequisites
- Node.js 18+ installed on your PC
- Windows PC (for building Windows .exe)

### Steps

```bash
# 1. Clone / copy this folder to your PC
cd vnus-agent

# 2. Install dependencies
npm install

# 3. Add your Firebase config
# Edit src/config.js and paste your Firebase project values

# 4. Build Windows installer
npm run build:win

# Output: dist/Vnus Agent Setup 1.0.0.exe
```

## Folder Structure

```
vnus-agent/
├── src/
│   ├── main.js          ← Electron main process
│   ├── preload.js       ← Secure IPC bridge
│   └── config.js        ← Firebase config (fill this!)
├── renderer/
│   └── splash.html      ← Demon UI screen
├── assets/
│   ├── icon.ico         ← Windows icon (add this)
│   ├── icon.icns        ← Mac icon (add this)
│   └── tray-icon.png    ← 16x16 tray icon (add this)
├── build/
│   └── installer.nsh    ← Windows installer script
└── package.json
```

## Assets Needed

You need to add icon files in `assets/`:
- `icon.ico` — 256x256 Windows icon
- `tray-icon.png` — 16x16 system tray icon
- `icon.png` — 512x512 PNG (for Linux + fallback)

Use the Vnus demon logo for these.

## Firebase Config

Edit `src/config.js`:

```js
const firebaseConfig = {
  apiKey: "YOUR_KEY",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456",
  appId: "1:123:web:abc",
};
```

Same Firebase project as your Next.js website!

## Firestore Rules

In Firebase Console → Firestore → Rules:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth.uid == userId;
    }
    match /agent_connections/{docId} {
      allow read, write: if request.auth != null || true;
    }
  }
}
```

The agent writes to `agent_connections` without auth (it's on local PC),
so that collection needs open write access.