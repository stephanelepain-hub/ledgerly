# Ledgerly

Ledgerly is a local-first accounting prototype built with **React Native, Expo SDK 54, and TypeScript**. It is designed for fast one-handed entry on modern Android phones while retaining compatibility with **Android 8 / API 26 and newer**.

The core workflow is intentionally confirmation-first:

> Camera or gallery → on-device ML Kit OCR → deterministic local parsing → confidence review → optional text-only cloud retry → user confirms → SQLite save.

## Implemented features

| Area | Implementation |
|---|---|
| Receipt intake | Camera capture and gallery import with image preview and permission handling |
| On-device OCR | Google ML Kit text recognition through `@infinitered/react-native-mlkit-text-recognition` |
| Local parsing | Merchant, total, date, and category inference with field-level and overall confidence |
| Cloud fallback | Optional structured LLM extraction for low-confidence scans; only recognized text is sent after explicit consent |
| Transaction management | Manual entry, receipt-prefilled review, confirmation before save, editing, and protected deletion |
| Categories | Predefined accounting categories plus custom local categories |
| Dashboard | Monthly, yearly, and all-time income, expenses, balance, recent activity, and category spending |
| History | Search plus transaction type and category filters |
| Persistence | Native Android uses versioned Expo SQLite; records remain on the device by default |
| Browser preview | Uses isolated AsyncStorage persistence to avoid concurrent browser SQLite/OPFS handle contention |

## Architecture

| Layer | Main files | Responsibility |
|---|---|---|
| Screens | `app/` | Dashboard, history, receipt capture, review, categories, and transaction forms |
| Accounting state | `lib/accounting-context.tsx` | Coordinates native SQLite operations and refreshes UI state |
| Native database | `lib/db.ts` | Versioned schema, category seeding, parameterized CRUD, and summary calculations |
| Receipt intelligence | `lib/receipt-ocr.ts`, `lib/receipt-parser.ts` | On-device recognition, deterministic extraction, category inference, and confidence scoring |
| Draft privacy | `lib/receipt-draft-store.ts` | Keeps unconfirmed scan results in memory rather than in the ledger |
| Cloud retry | `server/routers.ts` | Strictly validated structured extraction from recognized receipt text |
| Browser adapter | `lib/accounting-context.web.tsx` | Functional local preview without changing the Android SQLite path |

## Android development build

The OCR package contains native Android code, so receipt text recognition **does not run inside Expo Go**. Use a custom Expo development build.

Install dependencies and start the managed development services:

```bash
pnpm install
pnpm dev
```

With an Android device or emulator connected, create and install the custom build from another terminal:

```bash
pnpm exec expo run:android --no-bundler
```

The native development build derives the optional cloud server address from Expo's Metro host. A standalone deployment can provide `EXPO_PUBLIC_API_BASE_URL` through the project environment. The app remains usable without that endpoint; the user can edit locally parsed fields or enter a transaction manually.

## Android configuration

`app.config.ts` configures portrait orientation, camera and photo-library permission messaging, edge-to-edge Android rendering, and **`minSdkVersion: 26`**. The application package is `com.app.ledgerlymobile`.

The interface was visually checked at a **412 × 915** Pixel-class portrait viewport. Pixel 8 Pro and Android 17 remain compatible with the API 26 minimum because the minimum SDK controls the oldest supported Android release, not the newest supported device.

## Privacy behavior

Receipt images and accounting records stay local by default. ML Kit recognition and deterministic parsing run on the device. When a scan has low confidence, Ledgerly presents a separate cloud retry action and explains that only the recognized receipt text—not the image—is sent. No extracted transaction enters SQLite until the user selects **Confirm & save**.

## Validation

Run the automated checks with:

```bash
pnpm test
pnpm check
pnpm lint
pnpm exec expo export --platform web --output-dir dist
```

The focused tests cover receipt parsing, confidence behavior, amount validation, and period-based financial summaries. Camera capture and ML Kit recognition require validation on an installed Android development build because those native modules are unavailable in the browser preview and Expo Go.
