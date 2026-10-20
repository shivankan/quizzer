# Quiz JSON format

The format used by **Import**, **Export**, and the `seeds/` starter quizzes. A complete
worked example lives at [`seeds/_sample-all-options.json`](../seeds/_sample-all-options.json).

Paste this page into an AI assistant and ask it to write a quiz — the output can be
imported straight into Quizzer with **⬆ Import** on the host dashboard.

## Shape

```json
{
  "title": "Friday Pub Night",
  "questions": [ { ...question... } ]
}
```

## Question fields

| Field | Type | Applies to | Default | Notes |
|---|---|---|---|---|
| `type` | `"buzzer"` \| `"freetext"` \| `"select"` | all | `"buzzer"` | Anything else falls back to `buzzer` |
| `text` | string | all | `""` | The question itself |
| `points` | integer | all | `10` | Buzzer half-points round **down** (15 → 7) |
| `timer_seconds` | integer | all | `30` | See timer semantics below |
| `time_increment` | integer | all | `10` | Seconds the host's **+ Time** button adds |
| `multi_select` | boolean | `select` | `false` | `true` lets teams pick several options |
| `options` | string[] | `select` | `[]` | Minimum 2 |
| `correct` | integer[] | `select` | `[]` | **Zero-based indices** into `options` |
| `media_url` | string | all | `""` | `https://…`, `/uploads/…`, or a `data:` URI |
| `media_type` | `"image"` \| `"audio"` \| `"video"` | all | `""` | Must match the file; anything else is dropped |
| `media_scale` | integer 20–100 | image/video | `100` | Render width %, clamped server-side |
| `media_first` | boolean | all | `false` | `true` puts the media **above** the question text |

## Timer semantics — the part that catches people out

- **`buzzer` with `timer_seconds: 0`** — buzzers stay open until the host rules. Best
  default for pub rounds.
- **`buzzer` with `timer_seconds > 0`** — at zero, **buzzing closes**; anyone who hadn't
  buzzed is locked out. The host still rules on whoever queued.
- **`freetext` / `select` with `timer_seconds > 0`** — at zero the question **auto-ends**
  and goes to review. No grace period.

## Grading

- **`select`** is auto-graded and **exact-match**: a team must pick precisely the
  `correct` set. Partial answers and blanks score zero. The host can override any score
  before finalising.
- **`freetext`** is host-graded — every team starts at zero and the host marks each one.
- **`buzzer`**: first correct buzz scores full points; a correct buzz *after* a wrong
  attempt scores half (rounded down).

## Media

`media_url` accepts three forms:

1. **A public URL** — `https://example.com/pic.jpg`. Nothing is uploaded; the browser
   fetches it at play time. Best for AI-written quizzes.
2. **An uploaded path** — `/uploads/abc123.png`, produced by the editor's upload box.
3. **A `data:` URI** — `data:image/png;base64,…`. On import the server writes it to
   `uploads/` and rewrites the field, so a single `.json` carries its own media.

Export uses form 3 automatically, which is what makes an exported file portable.

## Minimal example

```json
{
  "title": "Quick Round",
  "questions": [
    { "type": "buzzer", "text": "Capital of France?", "points": 10, "timer_seconds": 0 },
    { "type": "freetext", "text": "Name a noble gas.", "points": 10, "timer_seconds": 30 },
    {
      "type": "select",
      "text": "Primary colours?",
      "points": 10,
      "timer_seconds": 20,
      "multi_select": true,
      "options": ["Red", "Green", "Blue", "Yellow"],
      "correct": [0, 2, 3]
    }
  ]
}
```

Unknown fields are ignored and missing ones take their defaults, so a terse file like the
above is perfectly valid.
