# TJR Hub — Token & Pre-Population Architecture

## System Overview

```
┌──────────────┐    webhook    ┌──────────────┐   generate    ┌──────────────┐
│   JointCal   │──────────────▶│  TJR Hub API │──────────────▶│ Token Service│
│  (scheduler) │               │   (backend)  │               │  (JWT + DB)  │
└──────────────┘               └──────┬───────┘               └──────┬───────┘
                                      │                              │
                                      │ lookup MRN                   │ tokenized URL
                                      ▼                              ▼
                               ┌──────────────┐              ┌──────────────┐
                               │ Patient Store│              │ SMS Gateway  │
                               │ (encrypted)  │              │  (Twilio)    │
                               └──────┬───────┘              └──────┬───────┘
                                      │                              │
                                      │ pre-populate                 │ SMS to patient
                                      ▼                              ▼
                               ┌──────────────┐              ┌──────────────┐
                               │ Intake Form  │◀─── taps ────│   Patient    │
                               │  (web app)   │    link      │   (phone)    │
                               └──────┬───────┘              └──────────────┘
                                      │
                                      │ submit
                                      ▼
                               ┌──────────────┐    FHIR     ┌──────────────┐
                               │  TJR Hub API │────────────▶│  Cerner/SIS  │
                               │  (backend)   │             │    (EMR)     │
                               └──────────────┘             └──────────────┘
```

---

## 1. The Trigger: Appointment Created

JointCal is the source of truth for scheduling. When an appointment is created or modified, it fires a webhook to the TJR Hub API.

### Webhook Payload (JointCal → TJR Hub)

```json
{
  "event": "appointment.created",
  "appointment_id": "APT-2026-00847",
  "patient": {
    "mrn": "MRN-445291",
    "first_name": "Dorothy",
    "last_name": "Mitchell",
    "dob": "1952-03-14",
    "phone": "+17705550143"
  },
  "schedule": {
    "date": "2026-03-15",
    "time": "09:30",
    "provider": "Dr. DeCook",
    "location": "Northside Clinic",
    "emr_system": "cerner"
  },
  "visit_type": "new_patient"
}
```

**Visit types from JointCal:** `new_patient`, `followup`, `pre_op`, `post_op_2wk`, `post_op_6wk`, `post_op_3mo`, `post_op_1yr`

The TJR Hub API receives this and initiates the intake pipeline.

---

## 2. Patient Lookup & Data Assembly

### 2a. New Patient (no prior MRN match)

```
JointCal webhook → MRN lookup → NO MATCH → create patient record → blank intake
```

Patient record created with only what JointCal provides:
- MRN, name, DOB, phone
- No prior intake data exists
- Form will be fully blank

### 2b. Returning Patient (MRN match found)

```
JointCal webhook → MRN lookup → MATCH → pull last intake → build pre-pop payload
```

The system pulls the most recent completed intake and builds a pre-population payload. Not all fields carry forward — some data is durable (rarely changes), some needs re-confirmation every visit.

### Field Durability Classification

| Durability | Fields | Behavior |
|---|---|---|
| **Permanent** | First name, last name, DOB | Pre-fill, show as read-only with "Not you?" link |
| **Durable** | Height, phone, insurance, caregiver, home setup, tobacco status, family history | Pre-fill, patient can edit |
| **Semi-durable** | Conditions, allergies, blood thinners, surgical history, medications | Pre-fill with "Still current?" confirmation prompt |
| **Per-visit** | Joint selection, pain levels, duration, treatments, functional limits, activity goals, post-op recovery | Always blank — must be fresh each visit |

### Pre-Population Payload Structure

```json
{
  "token": "eyJhbGciOiJBMjU2...",
  "patient_context": {
    "status": "returning",
    "last_visit": "2026-01-10",
    "visit_count": 3
  },
  "prefill": {
    "permanent": {
      "first_name": "Dorothy",
      "last_name": "Mitchell",
      "dob": { "month": 3, "day": 14, "year": 1952 }
    },
    "durable": {
      "height": "5_4",
      "weight": 165,
      "phone": "7705550143",
      "insurance": "medicare",
      "cg_rel": "husband",
      "cg_name": "Thomas Mitchell",
      "cg_phone": "7705550144",
      "tobacco": "never",
      "fam_clots": "no"
    },
    "semi_durable": {
      "conditions": ["diabetes", "cardiac_stenting"],
      "allergies": "Penicillin — rash",
      "blood_thin": "eliquis",
      "surg_hx": "R knee arthroscopy 2018",
      "a1c_known": "yes",
      "a1c_val": "7.1",
      "med_list": [
        { "d": "Eliquis (apixaban)", "b": "Eliquis", "g": "apixaban" },
        { "d": "Metformin (metformin)", "b": "Metformin", "g": "metformin" },
        { "d": "Lipitor (atorvastatin)", "b": "Lipitor", "g": "atorvastatin" }
      ]
    },
    "per_visit": {}
  }
}
```

---

## 3. Token Design

### Token Requirements

- No PHI in the URL (the token is an opaque pointer, not encrypted patient data)
- Time-limited: valid from 72 hours before appointment through 24 hours after
- Re-openable: patient can close and re-open before submitting
- Single-submit: once submitted, token is consumed (can view summary but not re-submit)
- Rate-limited: max 5 validation attempts per token per hour

### Token Generation

```
Token = base64url(random_bytes(32))
```

Simple random token, not a JWT. All state lives server-side. The token is just a lookup key.

**Why not JWT?** JWTs are self-contained — they carry data in the payload. That means the URL would contain patient-adjacent information (MRN, appointment ID) even if encrypted. A random opaque token keeps all PHI server-side. Simpler, safer.

### Token Record (Database)

```json
{
  "token": "k8Fj2mNpQrS9...",
  "mrn": "MRN-445291",
  "appointment_id": "APT-2026-00847",
  "created_at": "2026-03-13T10:00:00Z",
  "valid_from": "2026-03-12T09:30:00Z",
  "valid_until": "2026-03-16T09:30:00Z",
  "status": "pending",
  "validation_attempts": 0,
  "submitted_at": null,
  "visit_type": "new_patient",
  "emr_system": "cerner",
  "provider": "Dr. DeCook"
}
```

**Token statuses:** `pending` → `opened` → `submitted` → `expired`

### The URL

```
https://intake.tjrhub.com/i/k8Fj2mNpQrS9xL4wTzHvBn7
```

Short, clean, no query parameters, no PHI. That's what goes in the SMS.

---

## 4. SMS Delivery

### Timing Strategy

| Trigger | Timing | Message |
|---|---|---|
| **Initial send** | 48 hours before appointment | Full message with instructions |
| **Reminder** | 24 hours before (if not opened) | Shorter nudge |
| **Final reminder** | 4 hours before (if not submitted) | Urgency prompt |
| **Appointment day** | If still not submitted | "You can fill this out in the waiting room" |

### Message Templates

**Initial (48 hours before):**
```
TJR Hub: You have an appointment with Dr. DeCook on Mar 15 at 9:30 AM.

Please complete your pre-visit form before you arrive — it takes about 5 minutes:

https://intake.tjrhub.com/i/k8Fj2mNpQrS9xL4wTzHvBn7

This helps us spend more time talking about your care.

Reply STOP to opt out.
```

**Reminder (24 hours, not opened):**
```
TJR Hub: Reminder — your appointment is tomorrow at 9:30 AM.

Please complete your pre-visit form:
https://intake.tjrhub.com/i/k8Fj2mNpQrS9xL4wTzHvBn7

It takes about 5 minutes.
```

**Reminder (24 hours, opened but not submitted):**
```
TJR Hub: Looks like you started your pre-visit form but didn't finish.

Pick up where you left off:
https://intake.tjrhub.com/i/k8Fj2mNpQrS9xL4wTzHvBn7
```

**Final (4 hours, not submitted):**
```
TJR Hub: Your appointment is at 9:30 AM today.

Complete your form now to save time at check-in:
https://intake.tjrhub.com/i/k8Fj2mNpQrS9xL4wTzHvBn7
```

### SMS Gateway (Twilio)

```
Patient phone on file → Twilio API → SMS delivered
                          │
                          └─→ Delivery status webhook back to TJR Hub
                              (delivered, failed, undeliverable)
```

If SMS fails (bad number, carrier block), flag the record for front-desk outreach. Staff can hand the patient a tablet with the same tokenized URL at check-in.

---

## 5. Form Loading & Identity Verification

### Sequence When Patient Taps Link

```
1. Browser opens: intake.tjrhub.com/i/k8Fj2mNpQrS9xL4wTzHvBn7
2. Frontend calls: GET /api/intake/{token}/init
3. Backend validates token:
   - Exists? → 404 if not
   - Expired? → show "This link has expired" page
   - Already submitted? → show read-only summary
   - Rate limited? → 429
   - Valid → return patient context + prefill payload
4. Frontend renders form
```

### Identity Verification (Two-Factor)

The patient has already passed one factor by having the SMS on their phone (possession). The second factor is knowledge — confirming their DOB.

**For returning patients:**

Page 1 shows pre-filled name (read-only). DOB shows month/day/year dropdowns pre-selected but the patient must **tap "Confirm"** to proceed. This is the verification gate.

```
┌─────────────────────────────┐
│ 👤 Confirm Your Identity    │
│                             │
│ Dorothy Mitchell            │
│                             │
│ Please confirm your         │
│ date of birth:              │
│                             │
│ [March ▼] [14 ▼] [1952 ▼]  │
│                             │
│ [ Confirm & Continue → ]    │
│                             │
│ Not you? Contact our office │
│ at (770) 555-0100           │
└─────────────────────────────┘
```

Backend verifies the DOB matches before releasing any pre-fill data. If DOB doesn't match → lock the token, alert staff.

**For new patients:**

No verification gate — the form is blank. Name and DOB are collected as part of normal intake. Identity is verified by the fact that they received the SMS on the phone number JointCal has on file.

### GET /api/intake/{token}/init — Response

```json
{
  "status": "ok",
  "requires_verification": true,
  "patient_display_name": "Dorothy M.",
  "prefill_after_verification": true,
  "visit_type": "new_patient",
  "appointment": {
    "date": "2026-03-15",
    "time": "09:30",
    "provider": "Dr. DeCook",
    "location": "Northside Clinic"
  }
}
```

Note: no PHI in this initial response. Just enough to render the verification screen. Full prefill data only released after DOB confirmation.

### POST /api/intake/{token}/verify

```json
// Request
{ "dob_month": 3, "dob_day": 14, "dob_year": 1952 }

// Response (success)
{
  "verified": true,
  "prefill": { ... full prefill payload from section 2 ... }
}

// Response (failure)
{
  "verified": false,
  "attempts_remaining": 2,
  "message": "Date of birth doesn't match our records."
}
```

Max 3 DOB attempts. After 3 failures → token locked → staff alerted.

---

## 6. Form Behavior With Pre-Population

### New Patient Experience

Standard blank form as built. All sections required. Full data collection.

**Sections:** About You → Joint Pain → Per-Joint Pain → Medical History → Medications → Surgical Planning

### Returning Patient Experience

Pre-filled form with confirmation prompts on semi-durable data.

**Section modifications for returning patients:**

**About You** — Name/DOB read-only (verified in step 5). Height, weight, phone, insurance pre-filled and editable.

**Medical History** — Shows current conditions with confirmation:

```
┌─────────────────────────────┐
│ Your conditions on file:    │
│                             │
│ ✓ Diabetes                  │
│ ✓ Cardiac stenting          │
│                             │
│ ○ This is still correct     │
│ ○ I need to update this     │
│                             │
│ [expands full checklist     │
│  if "update" selected]      │
└─────────────────────────────┘
```

**Medications** — Shows current list with same confirm/update pattern:

```
┌─────────────────────────────┐
│ 💊 Your medications (3):    │
│                             │
│   Eliquis (apixaban)        │
│   Metformin (metformin)     │
│   Lipitor (atorvastatin)    │
│                             │
│ ○ This is still correct     │
│ ○ I need to make changes    │
│                             │
│ [if "changes" → show full   │
│  autocomplete with current  │
│  list editable]             │
└─────────────────────────────┘
```

**Surgical Planning** — Caregiver pre-filled. Patient confirms or updates.

### Auto-Save (Draft Persistence)

The form auto-saves progress every 30 seconds and on every page transition.

```
POST /api/intake/{token}/draft
{ "step": 3, "responses": { ... partial data ... } }
```

If the patient closes and re-opens the link, they resume where they left off. The form says:

```
"Welcome back — pick up where you left off."
[Continue from Step 3 →]   [Start Over]
```

---

## 7. Submission & Data Flow

### POST /api/intake/{token}/submit

```json
{
  "responses": {
    "first_name": "Dorothy",
    "last_name": "Mitchell",
    "dob_m": 3, "dob_d": 14, "dob_y": 1952,
    "height": "5_4",
    "weight": 165,
    "phone": "7705550143",
    "insurance": "medicare",
    "joints": ["right_knee"],
    "rep_right_knee": "no",
    "told_surg": "yes",
    "dur_right_knee": "gt_2yr",
    "pn_right_knee": 7,
    "pw_right_knee": 9,
    "tx_right_knee": ["pt", "cortisone", "nsaids"],
    "lim_right_knee": ["stairs", "walking", "sleeping"],
    "conds": ["diabetes", "cardiac_stenting"],
    "a1c_known": "yes",
    "a1c_val": "7.1",
    "blood_thin": "eliquis",
    "allergies": "Penicillin — rash",
    "surg_hx": "R knee arthroscopy 2018",
    "tobacco": "never",
    "fam_clots": "no",
    "med_list": [
      { "d": "Eliquis (apixaban)", "b": "Eliquis", "g": "apixaban" },
      { "d": "Metformin (metformin)", "b": "Metformin", "g": "metformin" },
      { "d": "Lipitor (atorvastatin)", "b": "Lipitor", "g": "atorvastatin" }
    ],
    "med_confirm": "yes",
    "cg_rel": "husband",
    "cg_name": "Thomas Mitchell",
    "cg_phone": "7705550144",
    "mobility": ["none"],
    "home": ["walk_in_shower", "grab_bars"],
    "goals": ["walking", "gardening", "grandkids", "stairs"]
  },
  "metadata": {
    "submitted_at": "2026-03-14T14:22:00Z",
    "duration_seconds": 342,
    "device": "iPhone Safari",
    "prefill_used": false,
    "sections_modified": []
  }
}
```

### Backend Processing Pipeline

```
Submit received
  │
  ├─ 1. Validate token (still valid, not already submitted)
  │
  ├─ 2. Save raw responses to patient store (encrypted at rest)
  │
  ├─ 3. Mark token as "submitted"
  │
  ├─ 4. Transform responses → SOAP structure
  │     (the mapping we already built into the form schema)
  │
  ├─ 5. Compute derived fields:
  │     ├─ BMI from height + weight
  │     ├─ Age from DOB
  │     ├─ Medication classifications (Policy 32846 engine)
  │     ├─ Pre-op risk flags (diabetic + cardiac + blood thinner)
  │     └─ Clearance auto-triggers (cardiac PMH → cardiac clearance)
  │
  ├─ 6. Generate provider workstation payload
  │     (pre-populate v8 provider note)
  │
  ├─ 7. Push to EMR via FHIR (if integration active)
  │     ├─ Cerner (Northside) → FHIR R4 Patient, Condition, MedicationStatement
  │     └─ SIS (ASC) → FHIR R4 or HL7v2 ADT (depending on SIS capabilities)
  │
  └─ 8. Return confirmation to patient
```

### SOAP Mapping (Responses → Provider Workstation)

```
Patient Intake Field              →  Provider Note Section
─────────────────────────────────────────────────────────
first_name, last_name, dob        →  Demographics header
height, weight → BMI              →  Vitals
phone, insurance                  →  Demographics
cg_rel, cg_name, cg_phone        →  Caregiver line
joints + rep_* + told_surg        →  Chief Complaint
dur_*, pn_*, pw_*                 →  HPI (per joint)
tx_*                              →  HPI prior treatments
lim_*                             →  HPI functional limitations
conds                             →  PMH (auto-mapped to ICD-10)
allergies                         →  Allergies section
blood_thin                        →  Medications (flagged)
surg_hx                           →  PSH
tobacco, tobacco_quit/amt         →  Social History
fam_clots                         →  Family History
med_list                          →  Medications table + Policy 32846
a1c_val                           →  Labs
cg_*, mobility, home, goals       →  Plan > Disposition
po_* (post-op fields)             →  HPI recovery status
po_concerns                       →  ROS equivalent for post-op
```

---

## 8. Security & HIPAA

### Data in Transit
- All endpoints HTTPS (TLS 1.3)
- No PHI in URLs, query parameters, or HTTP headers
- Token is the only identifier in the URL — opaque, random

### Data at Rest
- Patient store encrypted with AES-256
- Token records encrypted
- Database-level encryption (AWS RDS encrypted storage or equivalent)
- Backup encryption

### Access Controls
- Token endpoint: rate-limited (5 req/min per IP)
- DOB verification: max 3 attempts per token
- Failed verification → token locked + staff alert
- Submitted tokens cannot be re-submitted
- Expired tokens return no patient data
- API authentication for internal endpoints (provider workstation, admin)

### Audit Trail
Every interaction logged:

```json
{
  "event": "token.verified",
  "token_id": "k8Fj2mNp...",
  "mrn": "MRN-445291",
  "timestamp": "2026-03-14T14:18:00Z",
  "ip": "73.xxx.xxx.xxx",
  "user_agent": "iPhone Safari 19.3",
  "result": "success"
}
```

Events tracked: `token.created`, `sms.sent`, `sms.delivered`, `sms.failed`, `token.opened`, `token.verified`, `token.verify_failed`, `token.locked`, `draft.saved`, `intake.submitted`, `emr.pushed`, `token.expired`

### PHI Minimization
- SMS contains no health information — just appointment date/time and link
- Token init response contains no PHI until DOB verified
- Pre-fill payload only released after verification
- Browser localStorage is NOT used — all state server-side
- No cookies with PHI

---

## 9. Infrastructure

### Recommended Stack

| Component | Technology | Why |
|---|---|---|
| **API** | Node.js / Express or Python / FastAPI | Either works. Node aligns with JS form. |
| **Database** | PostgreSQL (encrypted) | HIPAA-eligible, relational, JSONB for flexible intake data |
| **Token Store** | PostgreSQL (same DB) or Redis with persistence | Tokens are short-lived, but need durability |
| **SMS** | Twilio | HIPAA BAA available, delivery webhooks, robust |
| **Hosting** | AWS (HIPAA-eligible) | EC2/ECS + RDS + S3 for documents |
| **EMR Integration** | FHIR R4 (Cerner), HL7v2 or FHIR (SIS) | Cerner has strong FHIR. SIS varies. |
| **Frontend** | Static HTML/JS (what we built) served via CDN | No server rendering needed. S3 + CloudFront. |

### Environment Architecture

```
                    ┌─────────────┐
                    │ CloudFront  │ ← Static form HTML/JS
                    │   (CDN)     │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   AWS ALB   │ ← HTTPS termination
                    │             │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌───────────┐ ┌──────────┐ ┌──────────┐
        │ API (ECS) │ │ API (ECS)│ │ API (ECS)│  ← Auto-scaling
        └─────┬─────┘ └────┬─────┘ └────┬─────┘
              │             │            │
              └─────────────┼────────────┘
                            ▼
                   ┌─────────────────┐
                   │  RDS PostgreSQL  │ ← Encrypted, Multi-AZ
                   │  (HIPAA-eligible)│
                   └─────────────────┘
```

---

## 10. Failure Modes & Fallbacks

| Failure | Detection | Fallback |
|---|---|---|
| SMS not delivered | Twilio webhook: `undelivered` | Flag for front desk. Staff hands patient tablet at check-in with same token URL. |
| Patient doesn't open link | Token status still `pending` at appointment time | Front desk hands tablet. Or staff enters data during rooming. |
| Patient starts but doesn't finish | Token status `opened`, draft saved | Reminder SMS. If still incomplete at visit, provider sees partial data flagged as incomplete. |
| DOB verification fails 3x | Token locked | Staff calls patient to verify identity before unlocking. |
| Patient's phone number wrong | SMS bounces | JointCal contact info update needed. Manual outreach. |
| EMR push fails | FHIR error response | Data saved locally in TJR Hub. Retry queue. Staff notified. Manual entry as last resort. |
| Token expired (patient late) | Token status check | Staff can generate a new token from admin panel — instant new SMS. |

---

## 11. Admin Panel (Staff View)

Staff need visibility into intake completion status for the day's schedule.

### Daily Dashboard View

```
┌─────────────────────────────────────────────────────────────┐
│  📋 Intake Status — March 15, 2026         Dr. DeCook      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  09:00  Johnson, Robert    New Patient   ✅ Submitted       │
│  09:30  Mitchell, Dorothy  New Patient   🟡 In Progress     │
│  10:00  Garcia, Patricia   Follow-Up     ✅ Submitted       │
│  10:30  Williams, Robert   Follow-Up     🔴 Not Opened      │
│  11:00  Chen, Margaret     Post-Op 6wk   ✅ Submitted       │
│  11:30  [blocked]                                           │
│  13:00  Thompson, James    Pre-Op        📱 SMS Failed      │
│  13:30  Anderson, William  Post-Op 1yr   ✅ Submitted       │
│                                                             │
│  5/7 complete  │  1 in progress  │  1 needs outreach       │
└─────────────────────────────────────────────────────────────┘
```

### Staff Actions
- **Resend SMS** — generates new token, sends fresh link
- **Generate tablet link** — QR code for in-office use
- **View submitted intake** — read-only summary of patient responses
- **Override token lock** — if DOB verification failed due to data mismatch
- **Mark as "will complete in office"** — removes from incomplete list

---

## 12. Metrics to Track

### Operational
- **Intake completion rate**: % of appointments with submitted intake before visit
- **Time to complete**: median minutes from open to submit
- **Pre-fill acceptance rate**: % of returning patients who confirm without changes
- **SMS delivery rate**: % of messages successfully delivered
- **Reminder conversion**: % who submit after reminder vs. initial send

### Clinical Efficiency
- **Rooming time reduction**: before/after intake automation
- **Data accuracy**: % of pre-filled data confirmed unchanged
- **Provider review time**: time spent reviewing intake before entering room

### Target Goals
| Metric | Target |
|---|---|
| Intake completion before visit | >75% within 6 months |
| Median completion time (new) | <6 minutes |
| Median completion time (returning) | <2 minutes |
| SMS delivery rate | >95% |
| Pre-fill acceptance (no changes) | >60% |

---

## 13. Implementation Phases

### Phase 1: Core Pipeline (Weeks 1-4)
- Token generation and validation API
- SMS delivery via Twilio
- Form served with token-based loading
- Basic patient store (save submissions)
- DOB verification gate

### Phase 2: Pre-Population (Weeks 5-8)
- Patient lookup by MRN
- Last-intake retrieval and prefill payload
- Returning patient confirmation UI
- Auto-save / draft persistence
- Resume from draft

### Phase 3: EMR Integration (Weeks 9-12)
- FHIR R4 push to Cerner
- SIS integration (FHIR or HL7v2 depending on capabilities)
- SOAP mapping engine
- Policy 32846 medication classification
- Provider workstation pre-population

### Phase 4: Operations (Weeks 13-16)
- Staff admin panel
- Daily intake status dashboard
- SMS failure handling and tablet fallback
- Metrics and reporting
- Reminder automation (48hr, 24hr, 4hr)

### Phase 5: Optimization (Ongoing)
- A/B test SMS timing and copy
- Refine field durability classifications based on actual change rates
- Add smart defaults based on visit type hints from JointCal
- Expand medication database based on actual patient entries
