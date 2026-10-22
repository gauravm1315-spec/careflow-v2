# CareFlow AI --- Human-in-the-Loop Multilingual Intake Assistant

CareFlow AI is a hackathon prototype that helps organize
patient-reported information into a structured, reviewable draft. It
supports a patient intake workflow, follow-up questions, report
processing paths, preliminary priority suggestions, and clinician
review.

> **Important:** CareFlow AI is a prototype, not a medical device. It
> does not diagnose or replace a qualified healthcare professional.
> Priority labels are preliminary workflow suggestions, not clinically
> validated risk scores. Use synthetic data only.

## Contents

-   [What it does](#what-it-does)
-   [Technology](#technology)
-   [How the workflow works](#how-the-workflow-works)
-   [Requirements](#requirements)
-   [Run locally](#run-locally)
-   [Configure Gemma 3 4B with
    Ollama](#configure-gemma-3-4b-with-ollama)
-   [Optional voice transcription](#optional-voice-transcription)
-   [Run tests](#run-tests)
-   [Project structure](#project-structure)
-   [Privacy and safety limitations](#privacy-and-safety-limitations)
-   [Troubleshooting](#troubleshooting)

## What it does

-   **Patient intake:** collect a patient's description of symptoms and
    answers to follow-up questions.
-   **Follow-up questions:** use standard questions when the model is
    unavailable, or model-assisted questions when the local SLM is
    available.
-   **Report processing:** extract text from supported text-based PDFs;
    a compatible vision-capable local model can interpret report photos.
-   **Structured draft:** organize symptoms, onset, history, medicines,
    allergies, report details, missing information and uncertainty for
    review.
-   **Preliminary priority suggestions:** combine deterministic
    warning-sign rules with a configurable priority workflow.
-   **Human review:** allow authorized clinician users to inspect the
    source context and review, override or approve a draft.
-   **Privacy masking:** attempt to detect and mask personal identifiers
    before sending text to the model.
-   **Fallback mode:** when Ollama or the model is unavailable, use a
    clearly labelled rule-based fallback for supported functions.

Feature availability depends on local configuration and the input type.
Verify each path in the running build before relying on it for a
demonstration.

## Technology

-   **Frontend:** HTML, CSS and browser JavaScript
-   **Backend:** Node.js
-   **SLM runtime:** Ollama
-   **Default model:** `gemma3:4b` (Gemma 3 4B, approximately 4 billion
    parameters)
-   **Persistence:** local JSON files
-   **Testing:** Node.js test runner and a fake Ollama service for
    model-adapter tests

The default configuration points Ollama to `http://127.0.0.1:11434`. The
application can start without Ollama, but model-generated features
require a compatible local model to be installed and running. This
repository is intended to be run locally; no hosted deployment is
required for the demo.

## How the workflow works

1.  A patient enters symptoms and answers follow-up questions in the web
    interface.
2.  The Node.js server validates the request and passes it to the intake
    pipeline.
3.  The pipeline applies privacy masking before a model request. The
    model adapter checks the Ollama endpoint and model status.
4.  If the configured local model is available, the application requests
    a draft and validates/normalizes the returned structure. If it is
    unavailable or the request fails, supported functions may use the
    labelled rule-based fallback.
5.  Safety rules and the priority workflow add preliminary warnings,
    reasons and supporting evidence.
6.  The draft and source context are presented for clinician review. A
    clinician remains responsible for the final decision.

**Model output is not guaranteed to be medically correct.** Validation
and evidence checks reduce some failure modes but do not establish
clinical accuracy.

## Requirements

-   Windows, macOS or Linux
-   Node.js **20 or newer**
-   A modern browser
-   Optional: [Ollama](https://ollama.com/download) and a compatible
    local model for SLM functionality
-   Optional: a compatible local Whisper server for local speech-to-text

## Run locally

### 1. Download the repository

Clone the repository or download the ZIP from GitHub, then open a
terminal in the project folder (the folder containing `package.json`).

``` bash
git clone https://github.com/gauravm1315-spec/careflow-v2.git
cd careflow-v2
```

If you downloaded the ZIP instead, extract it and open a terminal inside
the extracted project directory.

### 2. Check Node.js

``` bash
node --version
npm --version
```

Use Node.js 20 or newer.

### 3. Install dependencies

``` bash
npm install
```

The optional `compromise` package supports additional name-detection
heuristics. The application is designed to run without it, but masking
behavior may differ.

### 4. Start the application

``` bash
npm start
```

Open <http://localhost:3000> in your browser.

The default demo mode is enabled. The demo login information is shown on
the login page when `DEMO_MODE=1`; the default staff PIN in this
prototype is `2468`. Change or disable demo authentication before any
non-demo use. Do not expose this development server to the public
internet.

## Configure Gemma 3 4B with Ollama

1.  Install Ollama from <https://ollama.com/download>.

2.  Open a terminal and download the default model:

    ``` bash
    ollama pull gemma3:4b
    ollama list
    ```

3.  Ensure Ollama is running. The default endpoint is:

    ``` text
    http://127.0.0.1:11434
    ```

4.  Start CareFlow AI:

    ``` bash
    npm start
    ```

The application checks whether the local endpoint is reachable and
whether the configured model is installed. Check the server console or
the Administrator → System page for the reported model status.

### Optional environment settings

This repository version reads settings from environment variables and,
if present, a local `.env` file. `.env` is not included in the
repository; create it only if you need to change defaults. Never commit
`.env` or secrets.

  ---------------------------------------------------------------------------------
  Variable                     Default                      Purpose
  ---------------------------- ---------------------------- -----------------------
  `PORT`                       `3000`                       HTTP port

  `DEMO_MODE`                  enabled                      Enables demo-mode
                                                            behavior

  `STAFF_PIN`                  `2468`                       Demo staff PIN

  `SLM_ENABLED`                enabled                      Set to `0` to disable
                                                            model calls and use
                                                            fallback behavior

  `OLLAMA_URL`                 `http://127.0.0.1:11434`     Ollama endpoint

  `OLLAMA_MODEL`               `gemma3:4b`                  Installed Ollama model
                                                            tag

  `OLLAMA_TIMEOUT_MS`          `180000`                     Model request timeout
                                                            in milliseconds

  `OLLAMA_KEEP_ALIVE`          `30m`                        Ollama model keep-alive
                                                            setting

  `OLLAMA_VISION`              enabled                      Enables report-photo
                                                            handling for a
                                                            compatible vision model

  `WHISPER_URL`                unset                        Optional local
                                                            speech-to-text server

  `WHISPER_PATH`               `/v1/audio/transcriptions`   Speech service endpoint
                                                            path

  `WHISPER_MODEL`              `whisper-1`                  Model identifier
                                                            expected by the speech
                                                            service

  `WHISPER_TIMEOUT_MS`         `180000`                     Speech request timeout

  `PRIVACY_ALLOW_REMOTE_RAW`   disabled                     Remote raw-media
                                                            processing opt-in;
                                                            leave disabled for the
                                                            local demo
  ---------------------------------------------------------------------------------

For the intended local setup, keep `OLLAMA_URL` on loopback
(`127.0.0.1`) and keep `PRIVACY_ALLOW_REMOTE_RAW` disabled.

## Optional voice transcription

Local voice transcription requires a compatible Whisper-style service
running on the same machine. Configure `WHISPER_URL` and, if necessary,
`WHISPER_PATH` and `WHISPER_MODEL`. Without a local service, patients
can type; browser speech-to-text may be available only as an explicit
opt-in and can send audio to the browser vendor. Read the UI notice
before enabling it.

## Run tests

Run the automated test suite:

``` bash
npm test
```

The test suite uses a fake Ollama service for model-adapter tests, so
these tests do not require a real model download or internet access.
Tests cover API workflows, masking behavior, priority rules, fallback
paths and model-adapter error handling.

Passing automated tests does **not** prove that a real Gemma model
produces clinically accurate output. Real-model quality, performance on
your hardware, and optional speech service compatibility must be checked
separately.

## Project structure

``` text
careflow-v2/
├── config/
│   └── priority-rules.json  # Configurable prototype priority rules
├── lib/
│   ├── auth.js              # Demo authentication and role checks
│   ├── db.js                # Local JSON persistence and audit records
│   ├── env.js               # Environment configuration
│   ├── fallback.js          # Rule-based fallback extraction
│   ├── minipdf.js           # Small PDF helper used by the project
│   ├── normalize.js         # Normalize model output and check evidence quotes
│   ├── pdftext.js           # Text extraction from supported PDFs
│   ├── pii.js               # Identifier detection and masking
│   ├── pipeline.js          # Coordinates intake and processing
│   ├── priority.js          # Preliminary priority suggestions and queue ordering
│   ├── safety.js             # Deterministic warning-sign rules
│   ├── seed.js               # Synthetic demo data generation
│   ├── slm.js                # Ollama / local SLM adapter
│   └── stt.js                # Optional speech-to-text integration
├── public/
│   ├── index.html            # Web application entry page
│   ├── css/app.css           # Styling
│   └── js/                   # Browser UI, API, patient and staff logic
├── test/                     # Automated tests and fake Ollama service
├── server.js                 # Node.js HTTP server and API routes
├── package.json              # Scripts and dependencies
├── package-lock.json         # Locked dependency versions
└── README.md                 # This guide
```

Runtime data is stored under `data/` by default. Do not commit live
patient data, uploaded reports, secrets or personal information. For a
public submission, include only verified synthetic examples if any data
files are necessary.

## Privacy and safety limitations

-   This is a hackathon prototype and is **not suitable for real patient
    data or clinical deployment**.
-   Identifier masking is heuristic and can miss names, addresses or
    indirect identifiers. It may also mask harmless text.
-   The local JSON database is not encrypted at rest. Original source
    text and reports may be retained for authorized review.
-   Demo authentication uses a shared staff PIN by default. It is not
    production-grade authentication.
-   Do not expose the local server directly to the internet. TLS,
    production authentication, secure storage, retention controls and
    security review are not provided by this prototype.
-   Warning-sign patterns and priority thresholds are prototype rules
    and have not been clinically validated.
-   The application does not diagnose or replace clinical judgement. All
    output must be reviewed by a qualified professional.
-   Use only synthetic data in development, demos and public
    repositories.

## Troubleshooting

  -----------------------------------------------------------------------
  Problem                             What to check
  ----------------------------------- -----------------------------------
  Page does not open                  Confirm the server started
                                      successfully and visit
                                      `http://localhost:3000`. Check
                                      whether another process is using
                                      port `3000`; set `PORT` to another
                                      value if needed.

  Ollama is unreachable               Start Ollama and check
                                      `http://127.0.0.1:11434`; keep the
                                      endpoint on loopback for local use.

  Model is missing                    Run `ollama pull gemma3:4b`, then
                                      check `ollama list`.

  Output uses rule-based fallback     Check the server console or
                                      Administrator → System for the
                                      model status and fallback reason.

  Model request times out             The first request can be slow. Wait
                                      for model loading, close other
                                      heavy applications, or increase
                                      `OLLAMA_TIMEOUT_MS`.

  PDF text is not extracted           This reader supports text-layer
                                      PDFs, not every scanned or unusual
                                      PDF. Try a clear report photo if
                                      the configured vision model
                                      supports it, or enter the relevant
                                      values manually.

  Voice feature is unavailable        Configure a compatible local
                                      Whisper service, or use text input.
                                      Browser speech-to-text is a
                                      separate, opt-in path.

  `npm install` fails                 Check Node.js version and network
                                      access. The optional name-detection
                                      dependency may be unavailable; the
                                      app can run without it.
  -----------------------------------------------------------------------

## Team and submission

-   **Project:** CareFlow AI
-   **Team:** Null Pointers
-   **Repository:** <https://github.com/gauravm1315-spec/careflow-v2>

Thank you for reviewing CareFlow AI. Feedback on usability, robustness,
privacy and validation is welcome.
