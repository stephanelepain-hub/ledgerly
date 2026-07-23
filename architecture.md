# Ledgerly Prototype Architecture

## Selected Implementation

Ledgerly uses Expo SDK 54 and React Native 0.81. Transaction and category records are stored in `expo-sqlite` through a root `SQLiteProvider`; the database is persisted across application restarts and initialized with versioned migrations. The app uses local SQL only for financial data. No user account or cloud database is required.

Receipt images come from `expo-camera` or `expo-image-picker`. On Android, the selected OCR dependency is `@infinitered/react-native-mlkit-text-recognition` version 5.x because the maintainer explicitly maps version 5.x to Expo SDK 54, publishes a typed text-recognition module, and reports substantially broader package adoption than newly published alternatives. It runs Google ML Kit text recognition on-device and returns full text plus blocks, lines, and elements.

Because ML Kit is a native module, OCR requires a custom Expo development build or installed Android build rather than Expo Go. The JavaScript application guards unsupported web/native-module environments so the managed browser preview remains usable for the rest of the prototype. Android API 26 is above the selected module’s practical platform floor and will be configured explicitly with `expo-build-properties`.

The deterministic parser runs locally over OCR text. It extracts monetary candidates, prioritizes total-like labels, normalizes common date formats, chooses a likely merchant from early non-noise lines, classifies merchant/receipt tokens against category keywords, and produces per-field plus overall confidence. Results above the threshold open directly in the review form. Low-confidence results expose an opt-in cloud retry.

The cloud retry sends **OCR text and local candidate fields**, not the receipt image, to a public server-side tRPC procedure. The procedure uses the platform’s built-in LLM with a strict flat JSON schema and returns normalized transaction fields. This minimizes disclosure and avoids receipt-image upload/storage while still improving ambiguous structuring. The app displays explicit consent before the request, never triggers it automatically, and always requires user confirmation before writing to SQLite.

## Dependency and Runtime Decision Table

| Concern | Selected approach | Prototype rationale |
|---|---|---|
| Local records | `expo-sqlite` with WAL and versioned migrations | Durable on-device SQL, parameterized CRUD, aggregate queries, no account dependency |
| Receipt capture | `expo-camera` | Native camera preview and direct cached image URI |
| Gallery import | `expo-image-picker` | System image picker and compatible receipt file URIs |
| On-device OCR | `@infinitered/react-native-mlkit-text-recognition` 5.x | Explicit Expo SDK 54 compatibility and structured ML Kit output |
| Local parsing | Pure TypeScript parser | Offline, deterministic, testable, fast, and private |
| Cloud retry | Built-in server LLM via public tRPC procedure | Optional structured extraction without exposing credentials in the client |
| Cloud payload | OCR text plus local candidates | Improves parsing while avoiding receipt-image upload/storage |
| Web preview | OCR capability guard and informative fallback | Keeps the UI preview testable even though the native OCR module does not support web |
| Android floor | `minSdkVersion: 26` | Matches the requested Android 8 minimum while targeting modern Android builds |

## Data Model

| Entity | Important fields |
|---|---|
| Category | `id`, `name`, `icon`, `color`, `isCustom`, `createdAt` |
| Transaction | `id`, `type`, `amountMinor`, `date`, `categoryId`, `merchant`, `description`, `notes`, `receiptUri`, `ocrText`, `extractionSource`, `createdAt`, `updatedAt` |
| Receipt draft | In-memory `imageUri`, OCR text, candidate fields, per-field confidence, overall confidence, source state, and error state |

Amounts are stored as integer minor currency units to avoid floating-point persistence errors. Dates are persisted as ISO calendar dates, while timestamps use ISO strings. Receipt drafts remain in memory until the user confirms saving; canceling a draft does not create a transaction.

## Primary Modules

| Module | Responsibility |
|---|---|
| `lib/db.ts` | Schema migration, category seeding, and parameterized transaction/category queries |
| `lib/accounting-context.tsx` | Observable local data state, refresh operations, CRUD orchestration, and dashboard summaries |
| `lib/receipt-parser.ts` | Deterministic extraction and confidence scoring |
| `lib/receipt-ocr.ts` | Native OCR adapter, support checks, and platform-safe error handling |
| `lib/types.ts` | Shared local domain types and validation helpers |
| `server/routers.ts` | Opt-in cloud receipt extraction procedure only |
| `app/(tabs)` | Home, transaction history, receipt entry, and category navigation |
| `app/transaction-form.tsx` | Manual and receipt-prefilled confirmation form |
| `app/receipt-review.tsx` | OCR result review, low-confidence retry, correction, and save flow |

## External References

[1]: https://docs.expo.dev/versions/v54.0.0/sdk/sqlite/ "Expo SDK 54: SQLite"
[2]: https://docs.infinite.red/react-native-mlkit/ "React Native MLKit documentation"
[3]: https://docs.infinite.red/react-native-mlkit/text-recognition/ "React Native MLKit text recognition"
[4]: https://github.com/infinitered/react-native-mlkit "Infinite Red React Native MLKit repository and compatibility table"
[5]: https://www.npmjs.com/package/@infinitered/react-native-mlkit-text-recognition "React Native MLKit text recognition package"
[6]: https://docs.expo.dev/versions/latest/sdk/camera/ "Expo Camera documentation"
[7]: https://docs.expo.dev/versions/latest/sdk/imagepicker/ "Expo Image Picker documentation"
[8]: https://www.npmjs.com/package/expo-mlkit-ocr "Alternative Expo ML Kit OCR package evaluated"
