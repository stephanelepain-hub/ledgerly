# Ledgerly Mobile Interface Design

## Product Direction

Ledgerly is a local-first accounting prototype for quickly recording income and expenses, especially from paper receipts. The interface is designed for **mobile portrait orientation (9:16)** and comfortable **one-handed use** on a Pixel 8 Pro, while following mainstream Apple Human Interface Guidelines for hierarchy, touch targets, spacing, navigation, sheets, confirmations, and restrained motion.

The primary navigation is a four-tab bar: **Home**, **Transactions**, a visually prominent central **Scan** action, and **Categories**. High-frequency actions sit in the lower half of screens or in bottom sheets. Navigation titles, large headings, inset grouped cards, familiar icons, 44-point-or-larger touch targets, system typography, visible selection states, and confirmation before destructive or financial writes keep the app predictable.

## Screen List

| Screen | Primary content and functionality | Key layout decisions |
|---|---|---|
| Home | Current-period income, expenses, net balance, spending breakdown by category, recent transactions, period selector, quick add and receipt actions | Large title at top; compact period control; summary balance card; two equal metric cards; horizontal category breakdown; recent list; thumb-reachable quick actions |
| Transactions | Searchable and filterable transaction history with income/expense indicators, date grouping, category, merchant/description, and amount | Large title; filter chips beneath search; virtualized list; floating or header add action; tap row to edit |
| Transaction Editor | Manual entry or receipt-prefilled form for type, amount, date, merchant/description, category, receipt reference, and notes | Presented as a full-height modal; amount receives strongest visual hierarchy; segmented income/expense control; grouped fields; sticky Save button; always requires explicit confirmation |
| Receipt Source Sheet | Take a photo or select an image from the gallery | Bottom sheet with two large labeled actions and a privacy note explaining that processing starts on-device |
| Receipt Capture | Camera preview, framing guide, flash toggle, shutter, cancel, and gallery shortcut | Full-screen camera; uncluttered controls in lower safe area; high-contrast framing guide; no financial data is saved at capture time |
| Receipt Processing | Image preview, OCR and parsing progress, extracted text summary, confidence state, retry options | Clear staged status: image ready, reading text, structuring fields; local processing badge; low-confidence cloud option appears only when relevant |
| Receipt Review | Editable extracted transaction fields, per-field confidence cues, source preview, raw text disclosure, and save confirmation | Full-height modal; uncertain fields highlighted with concise helper text; receipt image remains accessible; Save stays disabled until required fields are valid |
| Categories | Predefined and custom categories with icon, color, transaction count, add, rename, and delete where allowed | Inset grouped list; system categories separated from custom categories; add control in navigation header; destructive custom-category deletion requires confirmation |
| Category Editor | Name, icon, and color selection for a custom category | Compact modal sheet with live preview and single primary action |
| Transaction Detail | Readable summary of one transaction, edit action, linked receipt thumbnail, and delete action | Key amount and type at top; metadata in grouped rows; destructive action separated at bottom |

## Key User Flows

### Receipt Capture and Local Extraction

1. The user taps **Scan** in the tab bar or **Scan receipt** on Home.
2. A bottom sheet offers **Take photo** and **Choose from gallery**.
3. The selected image opens in Receipt Processing.
4. On-device OCR extracts text; the local deterministic parser identifies candidate amount, date, merchant, and category and calculates overall and per-field confidence.
5. If confidence is high, Ledgerly opens Receipt Review with all inferred fields populated.
6. The user corrects any field, taps **Confirm & save**, reviews the concise confirmation, and saves to the local database.

### Low-Confidence Cloud Retry

1. Local OCR or parsing returns low confidence and shows exactly which fields are uncertain.
2. The app keeps the locally extracted values available and offers **Retry with cloud** as an optional secondary action.
3. A disclosure explains that the receipt image or OCR text will leave the device for this retry only.
4. If the user consents, the app sends the image and OCR text to the built-in cloud extraction endpoint and receives structured data with confidence.
5. The merged result returns to Receipt Review; the user still confirms before saving.
6. If the network request fails, the user can continue editing the local result without losing progress.

### Manual Transaction Entry

1. The user taps **Add transaction** from Home or Transactions.
2. The Transaction Editor opens with expense selected by default and today’s date.
3. The user enters amount, merchant/description, and category; optional notes may be added.
4. Validation is shown inline.
5. The user taps **Confirm & save**, then confirms the summarized transaction.
6. The database updates and the app returns with a subtle success confirmation.

### Review and Edit

1. The user opens Transactions and optionally searches or filters.
2. Tapping a row opens Transaction Detail.
3. Tapping **Edit** reuses the Transaction Editor with existing values.
4. Saving updates the local record and all dashboard summaries.
5. Deleting requires a destructive confirmation and never happens from a swipe alone.

### Category Management

1. The user opens Categories.
2. Predefined categories are immediately usable and protected from accidental deletion.
3. Tapping **Add category** opens the Category Editor.
4. After entering a unique name and selecting a color/icon, the user saves.
5. New categories become available immediately in transaction forms and parser classification.

## Visual System

Ledgerly uses a restrained financial palette with warm, readable surfaces rather than a generic blue template.

| Role | Color | Usage |
|---|---|---|
| Brand primary | `#176B5B` | Primary actions, active navigation, positive brand emphasis |
| Primary pressed | `#105348` | Pressed and focused states |
| Background | `#F5F5F1` | Main app background with low visual fatigue |
| Surface | `#FFFFFF` | Cards, forms, sheets, and grouped content |
| Foreground | `#18201E` | Primary text and high-contrast icons |
| Muted | `#66726E` | Secondary labels and supporting text |
| Border | `#DCE2DE` | Hairlines, field boundaries, and separators |
| Income | `#2E7D62` | Income labels and positive amounts |
| Expense | `#B75145` | Expense labels and negative amounts |
| Warning | `#B87918` | Low OCR confidence and attention states |
| Cloud accent | `#5267A8` | Optional cloud retry disclosure and status |
| Dark background | `#101513` | Dark appearance root background |
| Dark surface | `#1A211F` | Dark appearance cards and sheets |

Typography uses the platform system font. Large titles are 30–34 points, screen section titles 20–22 points, card values 24–32 points, body text 15–17 points, and metadata no smaller than 13 points. Amounts use tabular numerals where available. Corner radii remain moderate at 12–18 points. Shadows are minimal; hierarchy is primarily established with spacing, grouping, tint, and hairline borders.

## Interaction and Accessibility

All interactive targets are at least 44 by 44 points. Primary actions use clear verbs such as **Confirm & save** instead of vague labels. Forms support keyboard-aware scrolling, appropriate numeric/date keyboards, visible labels that do not disappear when typing, and inline validation. Color is never the sole indicator of transaction type or extraction confidence; icons, signs, and text labels reinforce meaning.

System appearance is supported, but light mode is the initial visual reference. Motion is limited to short fades and pressed-state scaling. Financial writes, receipt uploads, and deletions require explicit user intent. Offline and error states preserve work and provide a deterministic next action.

## Prototype Scope Decisions

The working prototype stores transactions, categories, and receipt metadata on-device. Receipt images remain local unless the user explicitly chooses the low-confidence cloud retry. The cloud fallback is not automatic. Authentication, cross-device sync, recurring bookkeeping, tax filing, bank connections, and background processing are outside this prototype’s scope.
