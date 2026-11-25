from __future__ import annotations

import logging
import os
from pathlib import Path
import smtplib
from email.message import EmailMessage

from backend.core.config import settings

logger = logging.getLogger(__name__)


def _get_smtp_settings() -> tuple[str, int, str, str, str, bool]:
    """Returns current SMTP configuration, dynamically falling back to .env if unpopulated."""
    host = settings.smtp_host or os.getenv("SMTP_HOST", "").strip()
    port = settings.smtp_port or int(os.getenv("SMTP_PORT", "587"))
    username = settings.smtp_username or os.getenv("SMTP_USERNAME", "").strip()
    password = settings.smtp_password or os.getenv("SMTP_PASSWORD", "").strip()
    from_addr = settings.smtp_from or os.getenv("SMTP_FROM", "security@nanvi.ai").strip()
    use_tls_raw = os.getenv("SMTP_USE_TLS", "true").lower() in ("true", "1", "yes")
    use_tls = settings.smtp_use_tls if settings.smtp_host else use_tls_raw

    if not host or not password:
        # Check if .env file exists and read directly from it to prevent stale in-memory settings
        candidates = [
            Path(__file__).resolve().parents[2] / ".env",
            Path.cwd() / ".env",
        ]
        for env_file in candidates:
            if env_file.exists():
                try:
                    from dotenv import dotenv_values
                    vals = dotenv_values(env_file)
                    if not host and vals.get("SMTP_HOST"):
                        host = str(vals.get("SMTP_HOST", "")).strip()
                    if vals.get("SMTP_PORT"):
                        port = int(str(vals.get("SMTP_PORT", "587")).strip())
                    if not username and vals.get("SMTP_USERNAME"):
                        username = str(vals.get("SMTP_USERNAME", "")).strip()
                    if not password and vals.get("SMTP_PASSWORD"):
                        password = str(vals.get("SMTP_PASSWORD", "")).strip()
                    if vals.get("SMTP_FROM"):
                        from_addr = str(vals.get("SMTP_FROM", "")).strip()
                    if vals.get("SMTP_USE_TLS"):
                        use_tls = str(vals.get("SMTP_USE_TLS", "true")).lower() in ("true", "1", "yes")
                    if host:
                        break
                except Exception:
                    pass

    return host, port, username, password, from_addr, use_tls


def send_password_reset_email(to_email: str, recipient_name: str, reset_link: str) -> bool:
    """Dispatches a password reset email with the secure token link.
    
    If SMTP credentials are not configured, logs the reset link securely for development/demo use.
    """
    subject = "Nanvi Enterprise - Password Reset Request"
    display_name = recipient_name.strip() or "User"
    
    plain_text = (
        f"Hello {display_name},\n\n"
        "A request to reset your password has been received for your Nanvi AI Enterprise Assistant account.\n\n"
        f"Please click or visit the following link to establish your new password:\n{reset_link}\n\n"
        "Security Note: This link is valid for 15 minutes.\n"
        "If you did not request this password reset, please ignore this email. Your current credentials remain secure.\n\n"
        "Regards,\n"
        "Nanvi Enterprise Security Team"
    )

    html_content = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Reset Your Password</title>
</head>
<body style="margin: 0; padding: 32px 16px; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0f172a;">
  <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
    <div style="margin-bottom: 24px; border-bottom: 1px solid #f1f5f9; padding-bottom: 16px; display: flex; align-items: center; justify-content: space-between;">
      <span style="font-size: 20px; font-weight: 800; color: #0f172a; letter-spacing: -0.03em;">NANVI</span>
      <span style="font-size: 11px; background: #f1f5f9; color: #475569; padding: 4px 8px; border-radius: 6px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">Enterprise Auth</span>
    </div>

    <h2 style="font-size: 20px; font-weight: 700; color: #0f172a; margin-top: 0; margin-bottom: 12px;">Reset Your Password</h2>
    <p style="font-size: 14px; line-height: 1.6; color: #475569; margin-bottom: 24px;">
      Hello <strong>{display_name}</strong>,<br>
      We received a request to reset your account password. Click the button below to choose your new password:
    </p>

    <div style="text-align: center; margin: 32px 0;">
      <a href="{reset_link}" style="display: inline-block; background: #000000; color: #ffffff; text-decoration: none; padding: 13px 32px; border-radius: 8px; font-size: 14px; font-weight: 600; letter-spacing: 0.01em; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);">
        Reset Password
      </a>
    </div>

    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; margin-bottom: 24px;">
      <p style="font-size: 12px; line-height: 1.5; color: #64748b; margin: 0;">
        <strong>Notice:</strong> This link is active for <strong>15 minutes</strong>. If the button above doesn't work, copy and paste this link into your browser:<br>
        <a href="{reset_link}" style="color: #2563eb; word-break: break-all; text-decoration: underline;">{reset_link}</a>
      </p>
    </div>

    <div style="border-top: 1px solid #f1f5f9; padding-top: 16px; font-size: 11px; color: #94a3b8; line-height: 1.4;">
      If you did not request a password reset, you can safely ignore this email. No changes will be made to your account.
    </div>
  </div>
</body>
</html>
"""

    smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, smtp_tls = _get_smtp_settings()
    if smtp_host:
        try:
            msg = EmailMessage()
            msg["Subject"] = subject
            msg["From"] = f"Nanvi AI Enterprise <{smtp_from}>"
            msg["To"] = to_email
            msg["Reply-To"] = smtp_from
            msg.set_content(plain_text)
            msg.add_alternative(html_content, subtype="html")

            with smtplib.SMTP(smtp_host, smtp_port, timeout=25) as server:
                if smtp_tls:
                    server.starttls()
                if smtp_user and smtp_pass:
                    server.login(smtp_user, smtp_pass)
                server.send_message(msg)

            logger.info("Successfully sent password reset email via SMTP to %s", to_email)
            return True
        except Exception as exc:
            logger.error("Failed to send reset email via SMTP to %s: %s", to_email, exc)
            return False

    # Local fallback / dev mode
    logger.info("[AUTH_MAILER] Password reset link for %s: %s", to_email, reset_link)
    print(f"\n[AUTH_MAILER] >>> Password reset link generated for {to_email}:\n{reset_link}\n")
    return True


def send_account_creation_email(
    to_email: str,
    recipient_name: str,
    username: str,
    password: str,
    reset_link: str,
) -> bool:
    """Dispatches an account creation email containing User ID, initial password, and password reset option.

    If SMTP credentials are not configured, logs the credentials and reset link securely for development/demo use.
    """
    subject = "Nanvi Enterprise - Your Account Credentials & Setup"
    display_name = recipient_name.strip() or "User"

    plain_text = (
        f"Hello {display_name},\n\n"
        "Your account for Nanvi AI Enterprise Assistant has been created.\n\n"
        "Here are your account credentials:\n"
        f"  User ID: {username}\n"
        f"  Temporary Password: {password}\n\n"
        "Password Reset Option:\n"
        f"If you wish to establish a new password immediately, please visit:\n{reset_link}\n\n"
        "Security Notice: This password reset link remains active for 24 hours.\n"
        "For security, please change your password upon your first sign in.\n\n"
        "Regards,\n"
        "Nanvi Enterprise Security Team"
    )

    html_content = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Your Account Credentials</title>
</head>
<body style="margin: 0; padding: 32px 16px; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0f172a;">
  <div style="max-width: 540px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
    <div style="margin-bottom: 24px; border-bottom: 1px solid #f1f5f9; padding-bottom: 16px; display: flex; align-items: center; justify-content: space-between;">
      <span style="font-size: 20px; font-weight: 800; color: #0f172a; letter-spacing: -0.03em;">NANVI</span>
      <span style="font-size: 11px; background: #f1f5f9; color: #475569; padding: 4px 8px; border-radius: 6px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">Enterprise Auth</span>
    </div>

    <h2 style="font-size: 20px; font-weight: 700; color: #0f172a; margin-top: 0; margin-bottom: 12px;">Your Account Credentials</h2>
    <p style="font-size: 14px; line-height: 1.6; color: #475569; margin-bottom: 24px;">
      Hello <strong>{display_name}</strong>,<br>
      Your Nanvi AI Enterprise Assistant account has been provisioned. Below are your login credentials:
    </p>

    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 18px 20px; margin-bottom: 24px;">
      <div style="margin-bottom: 12px;">
        <span style="font-size: 12px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em;">User ID</span>
        <div style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 2px; font-family: monospace;">{username}</div>
      </div>
      <div>
        <span style="font-size: 12px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em;">Temporary Password</span>
        <div style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 2px; font-family: monospace;">{password}</div>
      </div>
    </div>

    <div style="margin-bottom: 24px;">
      <h3 style="font-size: 15px; font-weight: 600; color: #0f172a; margin-top: 0; margin-bottom: 8px;">Password Reset Option</h3>
      <p style="font-size: 13px; line-height: 1.5; color: #475569; margin-bottom: 16px;">
        You can choose your own personal password immediately using the secure password reset link below:
      </p>
      <div style="text-align: center; margin: 20px 0;">
        <a href="{reset_link}" style="display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 14px; font-weight: 600; letter-spacing: 0.01em; box-shadow: 0 2px 4px rgba(37, 99, 235, 0.2);">
          Reset / Set New Password
        </a>
      </div>
      <p style="font-size: 12px; line-height: 1.5; color: #64748b; margin: 0;">
        Or copy and paste this link into your browser:<br>
        <a href="{reset_link}" style="color: #2563eb; word-break: break-all; text-decoration: underline;">{reset_link}</a>
      </p>
    </div>

    <div style="border-top: 1px solid #f1f5f9; padding-top: 16px; font-size: 11px; color: #94a3b8; line-height: 1.4;">
      Security Notice: This link remains active for 24 hours. For account security, we recommend updating your temporary password after logging in.
    </div>
  </div>
</body>
</html>
"""

    smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, smtp_tls = _get_smtp_settings()
    if smtp_host:
        try:
            msg = EmailMessage()
            msg["Subject"] = subject
            msg["From"] = f"Nanvi AI Enterprise <{smtp_from}>"
            msg["To"] = to_email
            msg["Reply-To"] = smtp_from
            msg.set_content(plain_text)
            msg.add_alternative(html_content, subtype="html")

            with smtplib.SMTP(smtp_host, smtp_port, timeout=25) as server:
                if smtp_tls:
                    server.starttls()
                if smtp_user and smtp_pass:
                    server.login(smtp_user, smtp_pass)
                server.send_message(msg)

            logger.info("Successfully sent account creation email via SMTP to %s (User ID: %s)", to_email, username)
            return True
        except Exception as exc:
            logger.error("Failed to send account creation email via SMTP to %s: %s", to_email, exc)
            return False

    # Local fallback / dev mode
    logger.info("[AUTH_MAILER] Account credentials dispatched for %s (username: %s): Reset link: %s", to_email, username, reset_link)
    print(f"\n[AUTH_MAILER] >>> Account credentials created for {to_email}:\n  User ID: {username}\n  Password: {password}\n  Reset link: {reset_link}\n")
    return True
