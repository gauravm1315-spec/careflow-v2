# CareFlow — human-in-the-loop multilingual triage assistant

Hackathon prototype for the **CareFlow AI** problem statement. Patients describe symptoms by text, voice or medical report;
the system organises the information with the evidence attached, asks follow-up questions, suggests a **preliminary** review
priority, and a clinician confirms, overrides and approves the note.

> **Not a medical device.** It does not diagnose. Priorities are preliminary triage *suggestions*, not validated risk scores.
> Use **synthetic data only**.

**Version 2** replaces the cloud Gemini dependency with an optional **local Gemma model via Ollama**, adds **PII masking** in front of
every model call, and adds a documented **priority scoring + automatic queue sorting** module. No API key is needed anywhere.

---

## 1. Quick start (Windows PowerShell)

Requirements: **Node.js 20 or newer** (`node -v`). Everything else is optional.

```powershell
cd careflow
copy .env.example .env          # edit later if you want a different model / settings
npm install                     # optional: installs the optional NER helper "compromise". The app also runs without it.
npm start                       # open http://localhost:3000
```

Run the tests:

```powershell
npm test                        # 65 tests, ~15 s, no model and no internet required
```

Sign in as **Patient** (no PIN), **Clinician** or **Administrator** (PIN `2468`, shown on the login page while `DEMO_MODE=1`).
The app starts with **synthetic demo cases** and works with **no model, no key and no internet**.

---

## 2. Install the local model (optional but recommended)

1. Install Ollama for Windows from <https://ollama.com/download> (or `winget install Ollama.Ollama`). It runs a local server on `127.0.0.1:11434`.
2. Download a Gemma model (the first download is a few GB):

   ```powershell
   ollama pull gemma3:4b         # default; fine for an 8 GB+ laptop
   ollama list                   # confirm it is installed
   curl.exe http://127.0.0.1:11434/api/tags      # confirm the server answers
   ```

   Other sizes: `gemma3:1b` (smallest, **text only** — set `OLLAMA_VISION=0`), `gemma3:12b` (better quality, needs ~16 GB RAM).
3. Configure (only if you changed something) in `.env`:

   ```ini
   OLLAMA_URL=http://127.0.0.1:11434
   OLLAMA_MODEL=gemma3:4b
   ```
4. Start the app: `npm start`. The console prints either
   `Language model: VERIFIED local — gemma3:4b at 127.0.0.1:11434` or the exact reason it is **not** active.
   The same status is on **Administrator → System**. The app never says "local" unless the endpoint is a loopback address **and** the model is confirmed installed.

CPU-only machines are slow (tens of seconds per case). `OLLAMA_TIMEOUT_MS` (default 180000) controls the wait; on timeout the case continues with the labelled fallback.

### Optional: local voice transcription
Voice needs a **Whisper-compatible server running on the same machine** (for example the whisper.cpp server or faster-whisper-server).
Set `WHISPER_URL` (and `WHISPER_PATH` / `WHISPER_MODEL` if your server differs). Audio is only sent to a loopback address.
Without it, the microphone button is off; patients can type, or explicitly opt in to **browser speech-to-text** (which sends audio to the browser vendor, e.g. Google in Chrome — the UI says so and it is off by default).

---

## 3. What works without the model, and what needs it

| Feature | No model | Ollama / Gemma | Local Whisper |
|---|:---:|:---:|:---:|
| Consent, text intake, follow-up questions, patient answers | ✅ (standard questions) | ✅ (tailored questions) | |
| Deterministic warning-sign rules (EN / Hindi / Hinglish), live while typing | ✅ | ✅ | |
| Summary of symptoms, onset, history, medicines, allergies | ✅ rule-based keyword extraction | ✅ model draft | |
| English translation, patient recap in their own language | ❌ (original text shown) | ✅ | |
| Text-based PDF reports (values, flags printed in the report, patient-vs-report conflicts) | ✅ | ✅ | |
| Report **photos** | attached unread; clinician opens the original | ✅ read by a vision-capable model | |
| Voice → text | typing, or opt-in browser STT | | ✅ |
| PII masking, priority scoring, automatic sorting, reasons & evidence | ✅ | ✅ | |
| Clinician confirm / override / approve, audit log, withdrawal & deletion | ✅ | ✅ | |

Every piece of content is **labelled** by provenance: *Local model draft*, *Rule-based fallback*, *Synthetic demo · rule-based*, *Clinician-confirmed*.

---

## 4. Privacy design

| Data | Where it goes |
|---|---|
| Patient text, answers, report text | Deterministic rules see the raw text. A **language model only ever receives masked text** (`[PERSON_1]`, `[PHONE_1]` …). |
| Placeholder ↔ original map ("vault") | Stored only in the server-side case record; never put in prompts, logs, audit entries or API responses. |
| Raw audio, report images/PDFs | Only sent to a **loopback** service (local Whisper / local Ollama). Blocked otherwise unless `PRIVACY_ALLOW_REMOTE_RAW=1`. |
| Browser speech-to-text | Off by default; explicit opt-in with a warning that the browser vendor processes the audio. |
| Audit log | IDs, actions and categories only — never patient text, names or free-text reasons. Hash-chained (tamper-evident). |
| Server console | No stack traces or payloads; startup status only. |

**Layers** (`lib/pii.js`): validated identifiers (Aadhaar via Verhoeff checksum, cards via Luhn, PAN, IFSC, EPIC, ABHA, e-mail, URLs, Indian and international phone numbers incl. Devanagari digits) →
context-keyed identifiers (MRN/UHID/passport/licence/account numbers, date of birth, PIN codes, house numbers, street/locality names, "I live at …") →
names (cue phrases in English/Hinglish/Hindi, titles, relations, a list of common Indian names, optional `compromise` NER) → propagation of detected names → **verification re-scan**.
A last-line guard in `lib/slm.js` refuses to send any prompt that still looks identifying. **If masking cannot be verified, nothing is sent to a model** and the patient continues with the non-AI workflow.

**Preserved:** symptoms, durations, medicines and doses, allergies, vitals and lab values, report dates.

### Privacy limitations (please read)
- Detection is **heuristic and not perfect**. An uncommon name with no cue phrase that is not in the built-in list is **missed** (a test documents this).
- Free-form addresses without keywords can be missed; rare indirect identifiers (a unique job, a tiny village) are not detected.
- Some harmless text is **over-masked** (a test documents spaced vitals that look like a mobile number).
- The original statement and reports are stored **unmasked** on the server for authorised staff; the `data/` folder is a plain JSON file — not encrypted.
- The optional `compromise` NER improves name recall but was **not exercised in my test environment** (no internet there).
- Demo only: shared staff PIN, name-based patient identity, no TLS. Not suitable for real patient data.

---

## 5. Priority scoring and sorting

Implemented in `lib/priority.js` with documented, editable parameters in `config/priority-rules.json` (also shown on **Administrator → System**).

Categories: **Urgent → Priority → Needs clarification → Routine**. Each case stores the suggestion, ordered **reasons**, linked **evidence** (quote + source: message / report page / patient answer), a timestamp, the clinician-confirmed priority (if any), and an override reason + audit record.

- Deterministic warning-sign rules (`lib/safety.js`) set a **floor**. The language model can **only escalate**, can never lower or erase a flag, and an *urgent* escalation requires a quote that was verified against the original text (otherwise capped at *Priority*).
- Missing key details, conflicts, unclear audio/translation/report text, low completeness, or an embedded instruction aimed at the system → at least **Needs clarification**. These never produce **Routine**.
- The thresholds (e.g. completeness 60 %) are **product settings for this prototype, not clinical thresholds**, and have not been medically validated.
- Queue order is computed on the server: category, then **longest waiting first**; approved cases last. A clinician override changes the order immediately (tested).
- Only **clinician** accounts can confirm / override / approve. Administrators have read-only access to cases.

---

## 6. Files changed in version 2

| File | Change |
|---|---|
| `lib/slm.js` **new** | Ollama adapter: verified status, structured-JSON calls, one repair retry, timeouts, error mapping, last-line privacy guard, loopback-only images |
| `lib/pii.js` **new** | PII detection / masking / vault / verification (see §4) |
| `lib/priority.js`, `config/priority-rules.json` **new** | Priority suggestion with reasons & evidence, documented parameters, queue sorting, waiting time |
| `lib/fallback.js` **new** | Clearly labelled rule-based extractor, lab-line parser, standard follow-up questions |
| `lib/stt.js`, `lib/pdftext.js`, `lib/minipdf.js` **new** | Optional local Whisper client; dependency-free PDF text reader; tiny PDF writer for demo/tests |
| `lib/normalize.js` **new** | Model-output normalisers & quote verification (kept from the old Gemini module, now provider-independent) |
| `lib/gemini.js` **removed** | No cloud AI calls remain |
| `lib/pipeline.js` **rewritten** | Mask → model → normalise, or labelled fallback; priority integration; role projections (vault never returned) |
| `lib/env.js`, `server.js` | New configuration; sorted queue; confirm/override/audit; clinician-only review actions; safe logging |
| `lib/seed.js` | Synthetic demo cases for every category, generated through the real pipeline in offline mode |
| `public/js/*.js`, `public/css/app.css` | Provenance labels, priority reasons/evidence, reviewed vs unreviewed, waiting time, privacy panel, opt-in browser STT, new System page |
| `test/*` | 65 automated tests (see §8); fake Ollama server; cross-platform runner |
| `.env.example`, `package.json`, `README.md` | Updated |

Unchanged: authentication and demo logins, local JSON persistence (no database), audit log (hash-chained), safety rules, frontend design and responsive layout, intake / follow-up / dashboard flows.

---

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Console says *Ollama is not reachable* | Start Ollama (`ollama serve` or the tray app). Use `OLLAMA_URL=http://127.0.0.1:11434` — on Windows `localhost` may resolve to IPv6 and fail. |
| *Model "gemma3:4b" is not installed* | `ollama pull gemma3:4b` (or set `OLLAMA_MODEL` to a model shown by `ollama list`). |
| Cases say *Rule-based fallback* with a timeout reason | CPU is slow: raise `OLLAMA_TIMEOUT_MS`, use `gemma3:1b`, or close other apps. The first request also loads the model into memory. |
| Report photos are "not machine-read" | Needs a vision-capable model (`gemma3:4b` or larger). For `gemma3:1b` set `OLLAMA_VISION=0`. |
| PDF rejected: *scanned PDF* | Only text-layer PDFs are read locally. Upload a clear photo instead, or type the key values. |
| Microphone button disabled | No `WHISPER_URL` configured — type, or opt in to browser speech-to-text (not private). |
| Everything falls back and the reason mentions masking | The privacy check could not verify masking, so no text was sent to a model (by design). |
| `npm install` fails | Not required. Skip it and run `npm start`; names are then detected without the optional NER. |
| Port in use | Change `PORT` in `.env`. |

---

## 8. Testing and verification status

`npm test` runs **65 automated tests** against the real code with a **fake Ollama server** (no model, no internet):

- **PII (19):** phones, e-mail, Aadhaar checksum, cards, PAN/IFSC/EPIC/ABHA, names (English/Hinglish/Hindi), addresses, DOB, record numbers, stable placeholders, vault separation, fail-closed verification, clinical-text preservation, false positives, two *documented* limitations, performance on hostile input.
- **Model adapter (15):** verified-local status, model missing, not running, remote endpoint never "local", disabled, structured JSON request, malformed JSON (repair once / fail), timeout, 404, 500, **unmasked text refused before sending**, raw images never sent to a non-loopback endpoint.
- **Priority (12):** no downgrade of safety flags, floors persist, model escalation caps, uncertainty never Routine, sorting, waiting-time tie-breaks, override changes order.
- **API / integration (19):** existing intake and role flows, bytes actually received by the fake model contain **no raw identifiers**, fail-closed fallback, model unavailable / timeout / malformed → labelled fallback, safety through the API, confirm/override/audit/queue re-ordering, admin read-only, seeded demo data, reports (PDF / photo), voice gating, audit log free of patient data, and an **egress check** that only loopback hosts were contacted.

I also ran the UI in headless Chromium against the real server with the fake model (patient flow, clinician queue, override re-ordering, evidence highlighting, admin pages, fallback notices, mobile width): no console errors. That script is `test/ui-smoke.mjs` (optional; needs Playwright). Several tests were mutation-checked (removing masking, the privacy guard, the safety floor or the verification cap makes specific tests fail).

Bugs found and fixed while testing: the previous-summary payload was reaching the model with restored (unmasked) quotes — caught by the privacy guard and now masked; a quadratic e-mail regex that took ~8 s on 50 000 letters; "ASHA worker" being masked as a name; a chest-pain phrasing ("tightness in my chest") missed by a warning-sign rule.

### NOT verified — please check manually
- **A real Gemma model through a real Ollama.** My environment had neither, so model calls were tested only against the fake. Output quality in Hindi/Hinglish, JSON compliance of `gemma3:4b`, and response times on your hardware are unknown. The code validates and falls back, but small models can be wrong — every model quote is re-checked against the source and unmatched ones are flagged.
- **Real Whisper transcription** and the exact request format of your chosen Whisper server (OpenAI-style `/v1/audio/transcriptions` is assumed; adjust `WHISPER_PATH`).
- **The optional `compromise` NER library** and `npm install` itself.
- **Running on Windows PowerShell** (written to be cross-platform; tested on Linux).
- **PDF reading** is a small dependency-free reader tested on simple PDFs; real lab PDFs with unusual fonts may not extract (the app then asks for a photo).
- Clinical suitability of the warning-sign patterns and the priority parameters — **not medically validated**.

### Still incomplete
- No encryption at rest, real authentication/SSO, TLS, retention policy or consent-versioning UI.
- Hindi handling in the rule-based fallback is keyword-based and limited; there is no translation without the model.
- Whisper confidence scores and per-word uncertainty are not available from the local speech service.
- Only the patient-facing flow is bilingual (English / Hindi); clinician screens are English.
