"""Outbound email for password resets. Stdlib only (smtplib + email).

Configure with environment variables:
    QUIZZER_SMTP_HOST   e.g. smtp.gmail.com
    QUIZZER_SMTP_PORT   default 587 (STARTTLS)
    QUIZZER_SMTP_USER   SMTP username
    QUIZZER_SMTP_PASS   SMTP password / app password
    QUIZZER_MAIL_FROM   From: address (defaults to SMTP_USER)
    QUIZZER_BASE_URL    public base URL used to build the reset link

If SMTP is not configured, the message is written to the server log instead of
being sent, so the flow stays usable locally. is_configured() lets the API tell
the host which of the two happened, rather than silently pretending to send.
"""
import os
import smtplib
import ssl
from email.message import EmailMessage


def _cfg(name, default=None):
    return os.environ.get(name, default)


def is_configured():
    return bool(_cfg("QUIZZER_SMTP_HOST") and _cfg("QUIZZER_SMTP_USER")
                and _cfg("QUIZZER_SMTP_PASS"))


def base_url(req_host=None):
    """Public base for links. Falls back to the Host header of the request."""
    u = _cfg("QUIZZER_BASE_URL")
    if u:
        return u.rstrip("/")
    if req_host:
        scheme = "https" if not req_host.startswith(("localhost", "127.0.0.1")) else "http"
        return f"{scheme}://{req_host}"
    return "http://localhost:8000"


def _build(to_addr, link):
    msg = EmailMessage()
    msg["Subject"] = "Reset your Quizzer password"
    msg["From"] = _cfg("QUIZZER_MAIL_FROM") or _cfg("QUIZZER_SMTP_USER") or "quizzer@localhost"
    msg["To"] = to_addr
    msg.set_content(
        "Someone asked to reset the password for your Quizzer host account.\n\n"
        f"Open this link to choose a new password:\n{link}\n\n"
        "The link works once and expires in 30 minutes.\n"
        "If you didn't ask for this, you can ignore this email — nothing changes.\n"
    )
    msg.add_alternative(
        "<div style=\"font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;"
        "max-width:480px;margin:0 auto;padding:24px;color:#1b1b2b\">"
        "<h2 style=\"margin:0 0 12px\">Reset your Quizzer password</h2>"
        "<p style=\"color:#555;line-height:1.5\">Someone asked to reset the password for your "
        "Quizzer host account. Choose a new one:</p>"
        f"<p style=\"margin:22px 0\"><a href=\"{link}\" "
        "style=\"background:linear-gradient(90deg,#4D7CFF,#9B5CFF);color:#fff;"
        "text-decoration:none;padding:13px 22px;border-radius:10px;font-weight:600;"
        "display:inline-block\">Choose a new password</a></p>"
        "<p style=\"color:#777;font-size:13px;line-height:1.5\">The link works once and expires "
        "in 30 minutes. If you didn't ask for this, ignore this email — nothing changes.</p>"
        f"<p style=\"color:#aaa;font-size:12px;word-break:break-all\">{link}</p></div>",
        subtype="html",
    )
    return msg


def send_reset(to_addr, link):
    """Returns (sent, detail). sent=False means it was logged, not delivered."""
    msg = _build(to_addr, link)
    if not is_configured():
        print("\n  [mail not configured] password reset link for %s:\n  %s\n" % (to_addr, link),
              flush=True)
        return False, "logged"
    host = _cfg("QUIZZER_SMTP_HOST")
    port = int(_cfg("QUIZZER_SMTP_PORT", "587"))
    user, pw = _cfg("QUIZZER_SMTP_USER"), _cfg("QUIZZER_SMTP_PASS")
    try:
        ctx = ssl.create_default_context()
        if port == 465:
            with smtplib.SMTP_SSL(host, port, context=ctx, timeout=20) as s:
                s.login(user, pw)
                s.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=20) as s:
                s.starttls(context=ctx)
                s.login(user, pw)
                s.send_message(msg)
        return True, "sent"
    except Exception as e:                      # noqa: BLE001 - surface any SMTP failure
        print(f"  [mail error] {type(e).__name__}: {e}", flush=True)
        print(f"  [mail fallback] reset link for {to_addr}: {link}", flush=True)
        return False, "error"
